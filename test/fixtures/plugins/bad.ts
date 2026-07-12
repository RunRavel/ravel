// A plugin that throws at import time — the loader must audit + skip it.
throw new Error("boom on import");
// eslint-disable-next-line no-unreachable
export default { name: "never" };
