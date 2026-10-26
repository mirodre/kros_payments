/** Jednoduché HTML stránky pre stavy prihlásenia (mimo SPA). */
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function layout(title, body) {
  return `<!DOCTYPE html>
<html lang="sk">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)} – Financie</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Public+Sans:wght@400;500;600;700&family=Schibsted+Grotesk:wght@500;600;700;800&display=swap">
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <main class="auth-page">
    <div class="auth-card">
      <h1>${esc(title)}</h1>
      ${body}
    </div>
  </main>
</body>
</html>`;
}

export function renderAuthPage(kind, { authServiceUrl } = {}) {
  switch (kind) {
    case 'unverified':
      return layout('Over si e-mail', `<p>Pred použitím aplikácie Financie je potrebné overiť e-mailovú adresu.</p>
        <p><a class="btn btn-primary" href="${esc(authServiceUrl)}/profil">Prejsť na môj účet</a></p>
        <p><a href="/login">Skúsiť znova</a></p>`);
    case 'no_org':
      return layout('Účet nemá organizáciu', `<p>Váš účet nie je priradený k žiadnej organizácii. Kontaktujte podporu krosdoplnky.sk.</p>
        <p><a href="/login">Skúsiť znova</a></p>`);
    case 'unavailable':
      return layout('Prihlasovanie je dočasne nedostupné', `<p>Prihlasovacia služba neodpovedá. Skúste to znova o chvíľu.</p>
        <p><a class="btn btn-primary" href="/login">Skúsiť znova</a></p>`);
    default:
      return layout('Prihlásenie zlyhalo', `<p>Prihlásenie sa nepodarilo dokončiť (vypršal čas alebo bolo prerušené).</p>
        <p><a class="btn btn-primary" href="/login">Prihlásiť sa znova</a></p>`);
  }
}
