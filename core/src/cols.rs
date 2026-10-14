//! Structure-of-arrays storage. A column group is declared once with `soa!`; that gives the struct,
//! a fixed-capacity constructor and a `describe` that lists every column for the manifest, so the
//! JavaScript side can build zero-copy typed-array views without hard-coding any offsets.
//!
//! Columns are allocated once at full capacity and never resized, so their addresses (and the
//! JS views over them) stay valid for the life of the world.

pub trait Elem: Copy + Default {
    const KIND: &'static str;
}
// element sizes come from size_of; KIND names the typed-array flavour for JS
impl Elem for f64 { const KIND: &'static str = "f64"; }
impl Elem for f32 { const KIND: &'static str = "f32"; }
impl Elem for u32 { const KIND: &'static str = "u32"; }
impl Elem for u16 { const KIND: &'static str = "u16"; }
impl Elem for u8 { const KIND: &'static str = "u8"; }

#[derive(Debug, Clone, Copy)]
pub struct ColumnDesc {
    pub group: &'static str,
    pub name: &'static str,
    pub kind: &'static str,
    pub ptr: usize,
    /// elements
    pub len: usize,
    /// bytes per element
    pub size: usize,
}

impl ColumnDesc {
    pub fn of<T: Elem>(group: &'static str, name: &'static str, col: &[T]) -> Self {
        ColumnDesc { group, name, kind: T::KIND, ptr: col.as_ptr() as usize, len: col.len(), size: std::mem::size_of::<T>() }
    }
}

macro_rules! soa {
    ($(#[$m:meta])* pub struct $name:ident { $($(#[$fm:meta])* $f:ident : $t:ty),* $(,)? }) => {
        $(#[$m])*
        pub struct $name {
            pub cap: usize,
            $($(#[$fm])* pub $f: Vec<$t>,)*
        }
        impl $name {
            pub fn with_capacity(cap: usize) -> Self {
                Self { cap, $($f: vec![<$t as Default>::default(); cap],)* }
            }
            /// Zero every column (capacity and addresses unchanged).
            pub fn clear(&mut self) { $(self.$f.fill(<$t as Default>::default());)* }
            pub fn describe(&self, group: &'static str, out: &mut Vec<$crate::cols::ColumnDesc>) {
                $(out.push($crate::cols::ColumnDesc::of(group, stringify!($f), &self.$f));)*
            }
        }
    };
}
pub(crate) use soa;

/// Named tuning values, stored as one f64 column so JS can read and tweak them live.
macro_rules! params {
    ($($name:ident = $default:expr; $doc:literal)*) => {
        #[allow(non_camel_case_types)]
        #[derive(Clone, Copy, Debug)]
        #[repr(usize)]
        pub enum P { $(#[doc = $doc] $name,)* }
        pub const PARAM_NAMES: &[&str] = &[$(stringify!($name),)*];
        pub fn param_defaults() -> Vec<f64> { vec![$($default,)*] }
    };
}
pub(crate) use params;
