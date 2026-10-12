/** Minimalistický „prehliadač“: cookie jar per host + ručné sledovanie redirectov. */
export function createBrowser() {
  const jars = new Map();
  const jar = (host) => {
    if (!jars.has(host)) jars.set(host, new Map());
    return jars.get(host);
  };

  async function request(url, init = {}) {
    const u = new URL(url);
    const cookies = [...jar(u.host)].map(([k, v]) => `${k}=${v}`).join('; ');
    const headers = { ...(init.headers || {}) };
    if (cookies) headers.cookie = cookies;
    const res = await fetch(u, { ...init, headers, redirect: 'manual' });
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(';').map((s) => s.trim());
      const idx = pair.indexOf('=');
      const name = pair.slice(0, idx);
      const value = pair.slice(idx + 1);
      const expired = attrs.some((a) => /^max-age=0$/i.test(a) || (/^expires=/i.test(a) && new Date(a.slice(8)) < new Date()));
      if (expired || value === '') jar(u.host).delete(name);
      else jar(u.host).set(name, value);
    }
    return res;
  }

  async function follow(url, init) {
    let current = url;
    let res = await request(current, init);
    for (let i = 0; i < 10 && [301, 302, 303, 307, 308].includes(res.status); i++) {
      current = new URL(res.headers.get('location'), current).toString();
      res = await request(current);
    }
    return { res, url: current };
  }

  return { request, follow, cookies: (host) => new Map(jar(host)) };
}
