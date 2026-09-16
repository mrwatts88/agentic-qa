// VIOLATES fe.storage.no-token-in-local-storage
export function persistSession(authToken: string): void {
  localStorage.setItem("authToken", authToken);
}

export function readSession(): string | null {
  return localStorage.getItem("authToken");
}
