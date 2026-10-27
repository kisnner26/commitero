// Clasifica un archivo por su ruta: que clase de cambio es y a que "funcion" pertenece.
const IMAGE = /\.(png|jpe?g|gif|webp|svg|ico|icns|wav|mp3|m4a|mp4|mov|pdf)$/i;
const DOC = /\.(md|mdx|txt|rst)$/i;
const TEST_DIR = /(^|\/)(tests?|__tests__|spec|specs)(\/|$)/i;
const TEST_FILE = /(\.test\.|\.spec\.|_test\.|_spec\.|Tests?\.[a-z]+$|SelfTest\.[a-z]+$)/i;
const CONFIG = /(^|\/)(\.env(\.[^/]*)?|package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|Package(\.resolved)?\.swift|Info\.plist|\.gitignore|\.gitattributes|tsconfig[^/]*\.json|Dockerfile|Makefile|build\.sh|install[^/]*\.sh|\.github\/.*|.*\.ya?ml|.*\.toml|.*\.entitlements)$/i;
const IGNORABLE = /(^|\/)(node_modules|\.build|build|dist|out|\.next|DerivedData|\.venv|__pycache__)(\/|$)|\.DS_Store$|\.log$|\.xcuserstate$/;

export function kindOf(path) {
  if (IGNORABLE.test(path)) return 'ignorable';
  if (TEST_DIR.test(path) || TEST_FILE.test(path)) return 'test';
  if (IMAGE.test(path) && /(^|\/)(docs?|assets?|images?|img|screenshots?|capturas)(\/|$)|README/i.test(path)) return 'asset';
  if (DOC.test(path) || /(^|\/)docs?\//i.test(path) || /(^|\/)(LICENSE|CHANGELOG|README)[^/]*$/i.test(path)) return 'doc';
  if (CONFIG.test(path)) return 'config';
  return 'code';
}

/** Nombre base sin extension y sin los sufijos de prueba: FooSelfTest.swift y foo.test.js -> Foo y foo. */
export function stemOf(path) {
  const name = path.split('/').pop();
  const base = name.replace(/\.[^.]+$/, '') || name;      // un archivo oculto como .env conserva su nombre
  return base
    .replace(/\.(test|spec)$/i, '')
    .replace(/(SelfTest|Tests?|Spec)$/, '')
    .replace(/[_-](test|spec)$/i, '')
    || base;
}

/** "SessionJournal" -> "session journal"; "cpu-script" -> "cpu script". */
export function humanize(stem) {
  return stem.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase().trim();
}
