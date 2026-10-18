import { Dpapi, isPlatformSupported } from '@primno/dpapi';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';

const entropy = Buffer.from('terrarium-core:chatgpt:dpapi:v1');
const magic = Buffer.from('TRC1');

export function protect(plaintext: string): Buffer {
  if (process.platform !== 'win32' || !isPlatformSupported)
    throw new Error('ChatGPT sign-in requires Windows protected storage.');
  const key = randomBytes(32);
  const bytes = Buffer.from(plaintext);
  try {
    const wrapped = Buffer.from(Dpapi.protectData(key, entropy, 'CurrentUser'));
    const header = Buffer.alloc(8);
    magic.copy(header);
    header.writeUInt32BE(wrapped.length, 4);
    const nonce = randomBytes(12);
    const aad = Buffer.concat([header, wrapped, nonce]);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(aad);
    const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
    return Buffer.concat([aad, cipher.getAuthTag(), encrypted]);
  } finally {
    key.fill(0);
    bytes.fill(0);
  }
}

export function unprotect(blob: Buffer): string {
  if (blob.length < 37 || !blob.subarray(0, 4).equals(magic))
    throw new Error('Invalid protected credentials.');
  const length = blob.readUInt32BE(4);
  if (length < 1 || length > 65536 || 8 + length + 28 >= blob.length)
    throw new Error('Invalid protected credentials.');
  const nonce = 8 + length,
    tag = nonce + 12;
  const key = Buffer.from(
    Dpapi.unprotectData(blob.subarray(8, nonce), entropy, 'CurrentUser'),
  );
  let first: Buffer | undefined, decoded: Buffer | undefined;
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      blob.subarray(nonce, tag),
    );
    decipher.setAAD(blob.subarray(0, tag));
    decipher.setAuthTag(blob.subarray(tag, tag + 16));
    first = decipher.update(blob.subarray(tag + 16));
    decoded = Buffer.concat([first, decipher.final()]);
    return decoded.toString('utf8');
  } finally {
    key.fill(0);
    first?.fill(0);
    decoded?.fill(0);
  }
}

export class ProtectedStorage {
  private file: string;
  constructor(readonly directory: string) {
    this.file = join(directory, 'chatgpt.bin');
  }
  read(): string | undefined {
    return existsSync(this.file)
      ? unprotect(readFileSync(this.file))
      : undefined;
  }
  write(value: string) {
    const encrypted = protect(value);
    mkdirSync(this.directory, { recursive: true });
    if (lstatSync(this.directory).isSymbolicLink())
      throw new Error('Credential storage must be a dedicated directory.');
    execFileSync(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `
$ErrorActionPreference = 'Stop'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = [System.Security.AccessControl.DirectorySecurity]::new()
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
$inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
$none = [System.Security.AccessControl.PropagationFlags]::None
$allow = [System.Security.AccessControl.AccessControlType]::Allow
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', $inherit, $none, $allow))
$system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($system, 'FullControl', $inherit, $none, $allow))
[System.IO.Directory]::SetAccessControl($env:TERRARIUM_CREDENTIAL_DIRECTORY, $acl)
`,
      ],
      {
        windowsHide: true,
        timeout: 15000,
        stdio: 'pipe',
        env: { ...process.env, TERRARIUM_CREDENTIAL_DIRECTORY: this.directory },
      },
    );
    writeFileSync(`${this.file}.pending`, encrypted, { mode: 0o600 });
    renameSync(`${this.file}.pending`, this.file);
  }
}
