#![allow(clippy::excessive_precision, clippy::approx_constant)] // fdlibm's literals, kept verbatim
//! Deterministic transcendental functions.
//!
//! `f64::sin` and friends call the platform's libm, which differs between the browser build
//! (Rust's own libm) and native builds (glibc), so a replay could diverge. These use only
//! IEEE basic operations (+ - * / sqrt, floor), which are correctly rounded everywhere, so the
//! same inputs give the same bits on every target. Kernels and constants follow fdlibm.

pub const PI: f64 = std::f64::consts::PI;
pub const TAU: f64 = std::f64::consts::TAU;
const FRAC_PI_2: f64 = std::f64::consts::FRAC_PI_2;
const INV_PIO2: f64 = 6.36619772367581382433e-01;
const PIO2_1: f64 = 1.57079632673412561417e+00; // first 33 bits of pi/2
const PIO2_1T: f64 = 6.07710050650619224932e-11; // pi/2 - PIO2_1

#[inline]
fn round(x: f64) -> f64 { (x + 0.5).floor() }

/// sin on [-pi/4, pi/4]
#[inline]
fn k_sin(x: f64) -> f64 {
    const S1: f64 = -1.66666666666666324348e-01;
    const S2: f64 = 8.33333333332248946124e-03;
    const S3: f64 = -1.98412698298579493134e-04;
    const S4: f64 = 2.75573137070700676789e-06;
    const S5: f64 = -2.50507602534068634195e-08;
    const S6: f64 = 1.58969099521155010221e-10;
    let z = x * x;
    x + x * z * (S1 + z * (S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)))))
}

/// cos on [-pi/4, pi/4]
#[inline]
fn k_cos(x: f64) -> f64 {
    const C1: f64 = 4.16666666666666019037e-02;
    const C2: f64 = -1.38888888888741095749e-03;
    const C3: f64 = 2.48015872894767294178e-05;
    const C4: f64 = -2.75573143513906633035e-07;
    const C5: f64 = 2.08757232129817482790e-09;
    const C6: f64 = -1.13596475577881948265e-11;
    let z = x * x;
    let hz = 0.5 * z;
    let w = 1.0 - hz;
    w + (((1.0 - w) - hz) + z * z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6))))))
}

/// Both at once: (sin x, cos x). Accurate to about 1e-16 for |x| up to about 1e6.
pub fn sin_cos(x: f64) -> (f64, f64) {
    let n = round(x * INV_PIO2);
    let r = (x - n * PIO2_1) - n * PIO2_1T;
    let (s, c) = (k_sin(r), k_cos(r));
    match (n as i64) & 3 {
        0 => (s, c),
        1 => (c, -s),
        2 => (-s, -c),
        _ => (-c, s),
    }
}

pub fn sin(x: f64) -> f64 { sin_cos(x).0 }
pub fn cos(x: f64) -> f64 { sin_cos(x).1 }

/// atan, fdlibm's argument reduction into five intervals plus an odd polynomial.
pub fn atan(x: f64) -> f64 {
    const HI: [f64; 4] = [4.63647609000806093515e-01, 7.85398163397448278999e-01, 9.82793723247329054082e-01, 1.57079632679489655800e+00];
    const LO: [f64; 4] = [2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17, 6.12323399573676603587e-17];
    const AT: [f64; 11] = [
        3.33333333333329318027e-01, -1.99999999998764832476e-01, 1.42857142725034663711e-01,
        -1.11111104054623557880e-01, 9.09088713343650656196e-02, -7.69187620504482999495e-02,
        6.66107313738753120669e-02, -5.83357013379057348645e-02, 4.97687799461593236017e-02,
        -3.65315727442169155270e-02, 1.62858201153657823623e-02,
    ];
    if x.is_nan() { return x; }
    let neg = x < 0.0;
    let mut a = x.abs();
    if a > 1e17 { return if neg { -FRAC_PI_2 } else { FRAC_PI_2 }; }
    let id: i32 = if a < 0.4375 { -1 } else if a < 0.6875 {
        a = (2.0 * a - 1.0) / (2.0 + a); 0
    } else if a < 1.1875 {
        a = (a - 1.0) / (a + 1.0); 1
    } else if a < 2.4375 {
        a = (a - 1.5) / (1.0 + 1.5 * a); 2
    } else {
        a = -1.0 / a; 3
    };
    let z = a * a;
    let w = z * z;
    let s1 = z * (AT[0] + w * (AT[2] + w * (AT[4] + w * (AT[6] + w * (AT[8] + w * AT[10])))));
    let s2 = w * (AT[1] + w * (AT[3] + w * (AT[5] + w * (AT[7] + w * AT[9]))));
    let r = if id < 0 { a - a * (s1 + s2) } else {
        let k = id as usize;
        HI[k] - ((a * (s1 + s2) - LO[k]) - a)
    };
    if neg { -r } else { r }
}

/// atan2 with the usual quadrant rules (the angle of the vector (x, y)).
pub fn atan2(y: f64, x: f64) -> f64 {
    if x > 0.0 { return atan(y / x); }
    if x < 0.0 { return if y >= 0.0 { atan(y / x) + PI } else { atan(y / x) - PI }; }
    if y > 0.0 { FRAC_PI_2 } else if y < 0.0 { -FRAC_PI_2 } else { 0.0 }
}

/// e^x, clamped to the finite range.
pub fn exp(x: f64) -> f64 {
    const LN2_HI: f64 = 6.93147180369123816490e-01;
    const LN2_LO: f64 = 1.90821492927058770002e-10;
    const INV_LN2: f64 = 1.44269504088896338700e+00;
    const P1: f64 = 1.66666666666666019037e-01;
    const P2: f64 = -2.77777777770155933842e-03;
    const P3: f64 = 6.61375632143793436117e-05;
    const P4: f64 = -1.65339022054652515390e-06;
    const P5: f64 = 4.13813679705723846039e-08;
    if x.is_nan() { return x; }
    if x > 709.0 { return f64::MAX; }
    if x < -708.0 { return 0.0; }
    let k = round(x * INV_LN2);
    let hi = x - k * LN2_HI;
    let lo = k * LN2_LO;
    let r = hi - lo;
    let t = r * r;
    let c = r - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
    let y = 1.0 - ((lo - (r * c) / (2.0 - c)) - hi);
    y * f64::from_bits(((k as i64 + 1023) as u64) << 52)
}

/// Natural log for x > 0 (0 or less gives -infinity): x = m 2^e with m in [sqrt(1/2), sqrt(2)), then
/// ln m = 2 atanh(z), z = (m - 1) / (m + 1), |z| < .172, by its odd series to z^25 (below 1e-19). Basic operations
/// only, so every target agrees bit for bit. Normal numbers only (subnormals read as 0).
pub fn ln(x: f64) -> f64 {
    const LN2: f64 = std::f64::consts::LN_2;
    if x.is_nan() { return x; }
    if x <= 0.0 || !x.is_normal() { return f64::NEG_INFINITY; }
    if x == f64::INFINITY { return x; }
    let bits = x.to_bits();
    let mut e = ((bits >> 52) & 0x7ff) as i64 - 1023;
    let mut m = f64::from_bits((bits & 0x000f_ffff_ffff_ffff) | 0x3ff0_0000_0000_0000); // [1, 2)
    if m >= std::f64::consts::SQRT_2 { m *= 0.5; e += 1; }
    let z = (m - 1.0) / (m + 1.0);
    let z2 = z * z;
    let mut sum = 0.0;
    for k in (0..13).rev() { sum = sum * z2 + 1.0 / (2 * k + 1) as f64; }
    2.0 * z * sum + e as f64 * LN2
}

/// Length of (x, y). Plain sqrt is correctly rounded on every target.
#[inline]
pub fn hypot(x: f64, y: f64) -> f64 { (x * x + y * y).sqrt() }

/// Wrap an angle into [-pi, pi).
#[inline]
pub fn wrap(a: f64) -> f64 { a - TAU * ((a + PI) / TAU).floor() }

#[inline]
pub fn clamp1(v: f64) -> f64 { v.clamp(-1.0, 1.0) }

#[cfg(test)]
mod tests {
    use super::*;

    fn samples() -> impl Iterator<Item = f64> {
        (0..200_001).map(|k| (k as f64 - 100_000.0) * 0.000_731 * 7.0) // about -512..512, irregular steps
    }

    #[test]
    fn sin_cos_match_std() {
        for x in samples() {
            let (s, c) = sin_cos(x);
            assert!((s - x.sin()).abs() < 2e-15, "sin({x}) = {s} vs {}", x.sin());
            assert!((c - x.cos()).abs() < 2e-15, "cos({x}) = {c} vs {}", x.cos());
        }
    }

    #[test]
    fn atan2_matches_std() {
        for (k, x) in samples().enumerate().step_by(7) {
            let y = ((k as f64) * 0.37).sin() * 900.0;
            let (a, b) = (atan2(y, x), y.atan2(x));
            assert!((a - b).abs() < 2e-15, "atan2({y}, {x}) = {a} vs {b}");
        }
        assert_eq!(atan2(0.0, 0.0), 0.0);
        assert_eq!(atan2(1.0, 0.0), FRAC_PI_2);
        assert_eq!(atan2(-1.0, 0.0), -FRAC_PI_2);
        assert!((atan2(0.0, -1.0) - PI).abs() < 1e-15);
    }

    #[test]
    fn ln_matches_std() {
        for &x in &[1e-300, 1e-12, 0.001, 0.25, 0.5, 0.70710678, 0.9999999, 1.0, 1.0000001, 1.41421356, 2.0, 2.718281828459045, 10.0, 12345.678, 1e100, 1e300] {
            let (a, b) = (ln(x), x.ln());
            assert!((a - b).abs() <= 2e-16 * b.abs().max(1.0), "ln({x}) = {a}, std {b}");
        }
        assert_eq!(ln(1.0), 0.0);
        assert_eq!(ln(0.0), f64::NEG_INFINITY);
        // an exponential draw: -ln(u) for u in (0, 1)
        for i in 1..1000 { let u = i as f64 / 1000.0; assert!((ln(u) - u.ln()).abs() < 1e-15, "{u}"); }
    }

    #[test]
    fn exp_matches_std() {
        for k in -6900..6900 {
            let x = k as f64 * 0.1013; // stays clear of the subnormal range, which exp clamps to 0
            let (a, b) = (exp(x), x.exp());
            assert!(((a - b) / b).abs() < 4e-16, "exp({x}) = {a} vs {b}");
        }
    }

    #[test]
    fn wrap_range() {
        for k in -1000..1000 {
            let a = wrap(k as f64 * 0.77);
            assert!((-PI..PI).contains(&a));
            assert!((sin(a) - sin(k as f64 * 0.77)).abs() < 1e-12);
        }
    }
}
