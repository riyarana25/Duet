/**
 * highlight.js ships types for its core via package "exports", which our node10-style
 * module resolution can't see for the per-language deep imports. Declare them once here.
 */
declare module 'highlight.js/lib/languages/*' {
  import { LanguageFn } from 'highlight.js';
  const lang: LanguageFn;
  export default lang;
}
