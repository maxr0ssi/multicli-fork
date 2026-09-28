const SAFE_LOCAL_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isSafeLocalIdentifier(value: string): boolean {
  return SAFE_LOCAL_IDENTIFIER.test(value);
}

export function requireSafeLocalIdentifier(value: string, label: string): string {
  if (!isSafeLocalIdentifier(value)) {
    throw new Error(
      `${label} must start with a letter or number and contain only letters, numbers, dots, underscores, or hyphens.`,
    );
  }
  return value;
}
