export interface SessionIdentity {
  subject: string;
  expiresAt: string;
}

export interface SessionReader {
  current(): Promise<SessionIdentity | null>;
}
