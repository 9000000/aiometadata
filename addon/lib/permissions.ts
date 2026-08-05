export type Permission = 'admin' | 'createConfig';

export const ALL_PERMISSIONS: Permission[] = ['admin', 'createConfig'];

export function isPermission(value: string): value is Permission {
  return (ALL_PERMISSIONS as string[]).includes(value);
}
