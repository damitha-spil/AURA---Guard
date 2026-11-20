// Everything the QA agent writes or streams passes through the masker first: strings are masked, and a
// string that looks like a secret is replaced, never kept. Ids, paths and hashes are left alone.
export { maskDeep } from "../chat/store.ts";
