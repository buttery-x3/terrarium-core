# Authentication implementation provenance

The user selected the existing ChatGPT authentication path in Flamehorn Desktop and social-summarizer-extension and explicitly approved `jose` 6.2.12 and `@primno/dpapi` 2.0.1.

`packages/lm-providers/src/chatgpt-auth.ts` adapts dynamic registration, loopback callbacks, PKCE, identity verification, plan-usage scopes, and refresh handling from Flamehorn Desktop's `src/main/credentials.ts`. `chatgpt.ts` follows its completed Responses stream handling and social-summarizer-extension's model catalog shape. `protected-storage.ts` adapts the DPAPI envelope and restricted storage pattern in social-summarizer-extension's `apps/helper/src/chatgpt/dpapi.ts` and `storage.ts`.

Terrarium has its own registration and credential directory. No other application's credentials are copied. The vendor SDK in social-summarizer-extension is not copied into this repository. Only the explicitly approved dependencies were added for this integration.

The adapted Flamehorn Desktop source carries this notice:

```text
MIT License

Copyright (c) 2026 Flamehorn Games

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
