//! Seeded random numbers (PCG32). Every sim decision draws from here, never from the host.

#[derive(Clone, Debug)]
pub struct Rng { state: u64, inc: u64 }

impl Rng {
    pub fn new(seed: u64) -> Self {
        let mut r = Rng { state: 0, inc: (0xda3e_39cb_94b9_5bdb << 1) | 1 };
        r.next_u32();
        r.state = r.state.wrapping_add(seed);
        r.next_u32();
        r
    }

    pub fn next_u32(&mut self) -> u32 {
        let old = self.state;
        self.state = old.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(self.inc);
        let xorshifted = (((old >> 18) ^ old) >> 27) as u32;
        xorshifted.rotate_right((old >> 59) as u32)
    }

    /// The full generator state, for snapshots.
    pub fn state(&self) -> (u64, u64) { (self.state, self.inc) }
    pub fn from_state(state: u64, inc: u64) -> Self { Rng { state, inc } }

    /// Uniform in [0, 1) with 53 bits of precision.
    pub fn next_f64(&mut self) -> f64 {
        let a = (self.next_u32() >> 5) as f64;
        let b = (self.next_u32() >> 6) as f64;
        (a * 67_108_864.0 + b) / 9_007_199_254_740_992.0
    }

    /// Uniform in [lo, hi).
    pub fn range(&mut self, lo: f64, hi: f64) -> f64 { lo + (hi - lo) * self.next_f64() }

    /// Uniform integer in [0, n).
    pub fn below(&mut self, n: u32) -> u32 { ((self.next_u32() as u64 * n as u64) >> 32) as u32 }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reproducible_and_in_range() {
        let (mut a, mut b, mut c) = (Rng::new(7), Rng::new(7), Rng::new(8));
        let mut differs = false;
        let mut mean = 0.0;
        for _ in 0..10_000 {
            let x = a.next_f64();
            assert_eq!(x.to_bits(), b.next_f64().to_bits());
            assert!((0.0..1.0).contains(&x));
            differs |= x != c.next_f64();
            mean += x / 10_000.0;
        }
        assert!(differs);
        assert!((mean - 0.5).abs() < 0.02);
        for _ in 0..1000 { assert!(a.below(5) < 5); }
    }
}
