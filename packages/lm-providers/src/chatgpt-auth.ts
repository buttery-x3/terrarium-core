import { createServer } from 'node:http';
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { ProtectedStorage } from './protected-storage.js';

type Registration = {
  hostId: string;
  clientId?: string;
  subject?: string;
  idToken?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string[];
  needsSignIn?: boolean;
};

export async function boundedJson(
  response: Response,
  limit = 1024 * 1024,
): Promise<Record<string, any>> {
  if (!response.body) throw new Error('ChatGPT returned no response body.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit)
        throw new Error('ChatGPT response exceeded the local size limit.');
      chunks.push(part.value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new Error('ChatGPT returned invalid JSON.');
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
}

export function validateCallback(url: URL, state: string, clientId?: string) {
  const actual = Buffer.from(url.searchParams.get('state') ?? '');
  const expected = Buffer.from(state);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new Error('Sign-in state did not match.');
  if (url.searchParams.has('error'))
    throw new Error('ChatGPT sign-in or plan permission was declined.');
  const issued = url.searchParams.get('client_id') ?? clientId;
  if (
    !issued ||
    issued === 'dynamic_agent_client' ||
    (clientId && issued !== clientId)
  )
    throw new Error('ChatGPT returned an unexpected registration.');
  const code = url.searchParams.get('code');
  if (!code) throw new Error('ChatGPT returned no authorization code.');
  return { clientId: issued, code };
}

export class ChatGptAuth {
  private record: Registration;
  private storage: ProtectedStorage;
  private refreshing?: Promise<string>;
  private unsaved = false;
  private pending = false;
  private error?: string;
  private cancelLogin?: () => void;

  constructor(
    directory = join(
      process.env.LOCALAPPDATA ?? join(homedir(), '.local', 'share'),
      'TerrariumCore',
      'credentials',
    ),
  ) {
    this.storage = new ProtectedStorage(directory);
    const stored = this.storage.read();
    try {
      this.record = stored
        ? JSON.parse(stored)
        : { hostId: `urn:uuid:${randomUUID()}` };
    } catch {
      throw new Error('ChatGPT credential storage is unreadable.');
    }
  }
  status() {
    return {
      connected: Boolean(
        this.record.accessToken &&
        !this.record.needsSignIn &&
        this.record.scopes?.includes('chatgpt.tokens.use.direct'),
      ),
      pending: this.pending,
      ...(this.error ? { error: this.error } : {}),
    };
  }
  private save() {
    this.unsaved = true;
    this.storage.write(JSON.stringify(this.record));
    this.unsaved = false;
  }
  close() {
    this.cancelLogin?.();
  }

  private async exchange(fields: Record<string, string>) {
    const response = await fetch(
      'https://auth.openai.com/api/accounts/oauth/token',
      {
        method: 'POST',
        redirect: 'error',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields),
        signal: AbortSignal.timeout(30000),
      },
    );
    const value = await boundedJson(response, 65536);
    if (!response.ok) {
      if (value.error === 'invalid_grant') {
        this.record.needsSignIn = true;
        this.save();
      }
      throw new Error(
        `ChatGPT sign-in needs attention (HTTP ${response.status}). Reconnect in the web interface.`,
      );
    }
    if (
      typeof value.access_token !== 'string' ||
      typeof value.expires_in !== 'number' ||
      value.token_type !== 'Bearer'
    )
      throw new Error('ChatGPT returned incomplete authorization.');
    return value;
  }

  async token(): Promise<string> {
    if (this.pending)
      throw new Error(
        'ChatGPT sign-in is in progress. Finish connecting before running agents.',
      );
    if (this.unsaved) this.save();
    if (!this.status().connected)
      throw new Error(
        'Connect ChatGPT and allow plan usage before starting agents.',
      );
    if ((this.record.expiresAt ?? 0) > Date.now() + 60000)
      return this.record.accessToken!;
    if (!this.refreshing) {
      this.refreshing = (async () => {
        if (!this.record.refreshToken || !this.record.clientId)
          throw new Error('Reconnect ChatGPT to renew this registration.');
        const value = await this.exchange({
          grant_type: 'refresh_token',
          client_id: this.record.clientId,
          refresh_token: this.record.refreshToken,
          resource: 'https://api.openai.com/v1',
        });
        if (typeof value.refresh_token !== 'string')
          throw new Error('ChatGPT did not renew the refresh token.');
        this.record = {
          ...this.record,
          accessToken: value.access_token,
          refreshToken: value.refresh_token,
          idToken: value.id_token ?? this.record.idToken,
          expiresAt: Date.now() + value.expires_in * 1000,
          scopes:
            typeof value.scope === 'string'
              ? value.scope.split(' ')
              : this.record.scopes,
        };
        this.save();
        if (!this.status().connected)
          throw new Error('Reconnect ChatGPT and grant plan usage permission.');
        return this.record.accessToken!;
      })().finally(() => {
        this.refreshing = undefined;
      });
    }
    return this.refreshing;
  }

  async beginSignIn() {
    if (this.pending)
      throw new Error('A ChatGPT sign-in is already in progress.');
    await this.refreshing;
    if (this.pending)
      throw new Error('A ChatGPT sign-in is already in progress.');
    this.save();
    this.pending = true;
    this.error = undefined;
    const state = randomBytes(32).toString('base64url'),
      nonce = randomBytes(32).toString('base64url');
    const verifier = randomBytes(64).toString('base64url');
    const server = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
    } catch (error) {
      this.pending = false;
      throw error;
    }
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Sign-in callback is unavailable.');
    const redirect = `http://127.0.0.1:${address.port}/auth/callback`;
    let consumed = false;
    const callback = new Promise<{ clientId: string; code: string }>(
      (resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('ChatGPT sign-in expired. Try again.')),
          600000,
        );
        this.cancelLogin = () =>
          reject(new Error('ChatGPT sign-in was cancelled.'));
        server.once('close', () => clearTimeout(timer));
        server.on('request', (request, response) => {
          const url = new URL(request.url ?? '/', redirect);
          response.setHeader('Content-Type', 'text/plain; charset=utf-8');
          response.setHeader('Cache-Control', 'no-store');
          if (request.method !== 'GET' || url.pathname !== '/auth/callback') {
            response.writeHead(404).end();
            return;
          }
          if (consumed) {
            response.writeHead(410).end('This sign-in attempt has ended.');
            return;
          }
          try {
            const result = validateCallback(url, state, this.record.clientId);
            consumed = true;
            clearTimeout(timer);
            response.end('Return to Terrarium Core to finish connecting.');
            resolve(result);
          } catch (error) {
            consumed = true;
            clearTimeout(timer);
            response
              .writeHead(400)
              .end('Sign-in failed. Return to Terrarium Core.');
            reject(error);
          }
        });
      },
    );
    const completion = (async () => {
      try {
        const result = await callback;
        this.record.clientId = result.clientId;
        this.record.needsSignIn = true;
        this.save();
        const value = await this.exchange({
          grant_type: 'authorization_code',
          client_id: result.clientId,
          code: result.code,
          code_verifier: verifier,
          redirect_uri: redirect,
          resource: 'https://api.openai.com/v1',
        });
        if (
          typeof value.id_token !== 'string' ||
          typeof value.refresh_token !== 'string'
        )
          throw new Error(
            'ChatGPT returned incomplete identity or renewal credentials.',
          );
        const response = await fetch(
          'https://auth.openai.com/.well-known/openid-configuration',
          { redirect: 'error', signal: AbortSignal.timeout(30000) },
        );
        if (!response.ok)
          throw new Error('ChatGPT identity metadata is unavailable.');
        const metadata = await boundedJson(response);
        if (
          metadata.issuer !== 'https://auth.openai.com' ||
          new URL(metadata.jwks_uri).origin !== 'https://auth.openai.com'
        )
          throw new Error('ChatGPT identity metadata is invalid.');
        const { payload } = await jwtVerify(
          value.id_token,
          createRemoteJWKSet(new URL(metadata.jwks_uri)),
          {
            issuer: metadata.issuer,
            audience: result.clientId,
            requiredClaims: ['sub', 'exp', 'iat', 'nonce'],
          },
        );
        if (
          payload.nonce !== nonce ||
          typeof payload.sub !== 'string' ||
          (this.record.subject && this.record.subject !== payload.sub)
        )
          throw new Error('ChatGPT returned a different or invalid identity.');
        this.record = {
          ...this.record,
          subject: payload.sub,
          accessToken: value.access_token,
          refreshToken: value.refresh_token,
          idToken: value.id_token,
          expiresAt: Date.now() + value.expires_in * 1000,
          scopes: typeof value.scope === 'string' ? value.scope.split(' ') : [],
          needsSignIn: false,
        };
        this.save();
        if (!this.status().connected)
          throw new Error(
            'Reconnect ChatGPT and allow plan usage in the browser.',
          );
      } catch (error) {
        this.error =
          error instanceof Error ? error.message : 'ChatGPT sign-in failed.';
        throw error;
      } finally {
        this.pending = false;
        this.cancelLogin = undefined;
        server.close();
        server.closeAllConnections();
      }
    })();
    void completion.catch(() => {});
    const params = new URLSearchParams({
      client_id: this.record.clientId ?? 'dynamic_agent_client',
      ext_agent_host_id: this.record.hostId,
      response_type: 'code',
      redirect_uri: redirect,
      scope:
        'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
      resource: 'https://api.openai.com/v1',
      state,
      nonce,
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    });
    if (!this.record.clientId) params.set('agent_name_hint', 'Terrarium Core');
    if (this.record.idToken) params.set('id_token_hint', this.record.idToken);
    params.set('prompt', 'consent');
    return {
      url: `https://auth.openai.com/api/accounts/authorize?${params}`,
      completion,
    };
  }
}
