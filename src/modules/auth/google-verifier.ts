import { UnauthorizedException } from '@nestjs/common';
import { OAuth2Client } from 'google-auth-library';

export interface GoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string;
  /** Dominio de Google Workspace (`hd`), si la cuenta pertenece a uno. */
  hostedDomain?: string;
}

export interface GoogleIdTokenVerifier {
  verify(idToken: string): Promise<GoogleIdentity>;
}

export const GOOGLE_VERIFIER = Symbol('GOOGLE_VERIFIER');

/** Verificación real: firma, `aud` y vigencia con google-auth-library. */
export class GoogleAuthLibraryVerifier implements GoogleIdTokenVerifier {
  private readonly client: OAuth2Client;

  constructor(private readonly clientId: string) {
    this.client = new OAuth2Client(clientId);
  }

  async verify(idToken: string): Promise<GoogleIdentity> {
    if (!this.clientId) {
      throw new UnauthorizedException('Google login is not configured');
    }
    try {
      const ticket = await this.client.verifyIdToken({
        idToken,
        audience: this.clientId,
      });
      const payload = ticket.getPayload();
      if (!payload?.sub || !payload.email) throw new Error('incomplete');
      return {
        sub: payload.sub,
        email: payload.email,
        emailVerified: payload.email_verified === true,
        name: payload.name ?? payload.email,
        hostedDomain: payload.hd,
      };
    } catch {
      throw new UnauthorizedException('Invalid Google token');
    }
  }
}

/**
 * Solo desarrollo y pruebas (`AUTH_ALLOW_FAKE_GOOGLE=true`, prohibido en
 * producción por el esquema de entorno). Formato: `fake:<email>[:<nombre>]`.
 */
export class FakeGoogleVerifier implements GoogleIdTokenVerifier {
  verify(idToken: string): Promise<GoogleIdentity> {
    const [prefix, email, name] = idToken.split(':');
    if (prefix !== 'fake' || !email) {
      return Promise.reject(new UnauthorizedException('Invalid Google token'));
    }
    return Promise.resolve({
      sub: `fake-${email.toLowerCase()}`,
      email,
      emailVerified: true,
      name: name ?? email,
      hostedDomain: email.split('@')[1],
    });
  }
}
