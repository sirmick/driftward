"""A small mixed-integer modelling layer over scipy.optimize.milp (HiGHS), so the galaxy's models read as variables
and constraints rather than matrices. Expressions are dicts of variable index -> coefficient.

    m = Model()
    x = m.binary('x'); y = m.var('y', 0, 10)
    m.add({x: 1, y: 2}, hi=8)           # x + 2y <= 8
    m.maximize({x: 3, y: 1})
    sol = m.solve(time_limit=60)        # sol[x], sol.value({x: 1, y: 1})

Constraints may carry a tag (m.add(..., tag='quota')): when a model is infeasible, m.diagnose() solves it again with
every tagged constraint allowed to slip, at a cost, and reports which tags had to.
"""
import time
import numpy as np
from scipy.optimize import milp, LinearConstraint, Bounds
from scipy.sparse import coo_matrix

class Model:
    def __init__(self):
        self.lb, self.ub, self.integer, self.names = [], [], [], []
        self.rows, self.cols, self.vals, self.lo, self.hi = [], [], [], [], []
        self.c, self.sense = {}, 1
        self.tags = []

    def var(self, name, lb=0, ub=np.inf, integer=False):
        self.lb.append(lb); self.ub.append(ub); self.integer.append(1 if integer else 0); self.names.append(name)
        return len(self.lb) - 1

    def binary(self, name):
        return self.var(name, 0, 1, True)

    def fix(self, v, value):
        self.lb[v] = self.ub[v] = value

    def add(self, expr, lo=-np.inf, hi=np.inf, tag=None):
        """lo <= expr <= hi; an expression with no terms must already hold."""
        if not expr:
            assert lo <= 0 <= hi, 'an empty constraint that cannot hold'
            return
        r = len(self.lo)
        for v, a in expr.items():
            if a: self.rows.append(r); self.cols.append(v); self.vals.append(a)
        self.lo.append(lo); self.hi.append(hi); self.tags.append(tag)

    def eq(self, expr, value, tag=None): self.add(expr, value, value, tag)

    def minimize(self, expr): self.c, self.sense = dict(expr), 1
    def maximize(self, expr): self.c, self.sense = dict(expr), -1

    def size(self):
        return f'{len(self.lb):,} variables ({sum(self.integer):,} integer), {len(self.lo):,} constraints'

    def solve(self, time_limit=120, gap=.01, verbose=False):
        n = len(self.lb)
        c = np.zeros(n)
        for v, a in self.c.items(): c[v] += a * self.sense
        A = coo_matrix((self.vals, (self.rows, self.cols)), shape=(len(self.lo), n)).tocsr()
        t = time.time()
        r = milp(c, constraints=LinearConstraint(A, self.lo, self.hi), integrality=np.array(self.integer),
                 bounds=Bounds(self.lb, self.ub), options={'time_limit': time_limit, 'mip_rel_gap': gap, 'disp': verbose})
        if r.x is None:
            raise RuntimeError(f'no solution: {r.message}')
        return Solution(r, time.time() - t, self.sense)

    def diagnose(self, time_limit=120):
        """Which tagged constraints an infeasible model cannot meet: each tagged row gets slack both ways, the
        objective is the total slack, and the result is {tag: (rows that slipped, total slack)}."""
        saved = (self.lb[:], self.ub[:], self.integer[:], self.names[:], self.rows[:], self.cols[:], self.vals[:], self.c, self.sense)
        slack = []
        for r, tag in enumerate(self.tags):
            if tag is None: continue
            up, dn = self.var(f'+{r}'), self.var(f'-{r}')
            self.rows += [r, r]; self.cols += [up, dn]; self.vals += [1, -1]
            slack.append((tag, up, dn))
        self.minimize({v: 1 for _, a, b in slack for v in (a, b)})
        try:
            s = self.solve(time_limit=time_limit, gap=0)
        finally:
            (self.lb, self.ub, self.integer, self.names, self.rows, self.cols, self.vals, self.c, self.sense) = saved
        out = {}
        for tag, a, b in slack:
            v = s[a] + s[b]
            if v > 1e-6: n, tot = out.get(tag, (0, 0)); out[tag] = (n + 1, tot + v)
        return out

class Solution:
    def __init__(self, r, seconds, sense):
        self.x, self.status, self.message, self.seconds = r.x, r.status, r.message, seconds
        self.objective = r.fun * sense
        self.gap = getattr(r, 'mip_gap', None)

    def __getitem__(self, v): return self.x[v]
    def on(self, v): return self.x[v] > .5
    def value(self, expr): return sum(a * self.x[v] for v, a in expr.items())
    def report(self):
        gap = f', gap {self.gap:.1%}' if self.gap is not None else ''
        return f'{self.message.split(".")[0]} in {self.seconds:.1f} s, objective {self.objective:.1f}{gap}'
