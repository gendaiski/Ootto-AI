# ootto.ai – UI clone (pending network access)

Target: https://ootto.ai/

The clone could not be produced yet: outbound access to `ootto.ai` is denied by the
cloud environment's network egress policy (HTTP CONNECT rejected with 403). Server-side fetch
is blocked too, and no archive mirror (web.archive.org, archive.ph, allorigins, Google cache)
is reachable, so the page markup, styles, fonts and images could not be captured.

To unblock, either:

1. Allow `ootto.ai` (plus its asset/CDN hosts) in the environment's **Network access**
   settings (cloud environment menu in the session title bar → Edit), then ask for the clone
   again, or
2. Save the page(s) from a browser ("Save as… Webpage, Complete") and a few full-page
   screenshots (desktop + mobile) and drop them into `reference/` in this folder.

Once the reference is available the clone will be built here as a static site (HTML + CSS +
assets), page by page, section by section, header, menus and footer included, following the
same conventions as `sites/open-webui-clone`.

See `BUSINESS-MODEL.md` for what is publicly known about the offer and pricing.
