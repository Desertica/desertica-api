export interface AuthUser {
  id: string;
  email: string;
  name: string;
  roleKey: string;
  permissions: ReadonlySet<string>;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
  }
}
