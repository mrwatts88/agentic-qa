export function remember(token: string): void {
  localStorage.setItem("authToken", token);
}
