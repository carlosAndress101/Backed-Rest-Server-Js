// Plain actors for service-unit tests: no database, no mongoose or bcrypt, just the `{ id, role }` a service
// receives from the authenticated request (AM-M5-10).
export interface TestActor {
  id: string;
  role: 'USER_ROLE' | 'VENTAS_ROLE' | 'ADMIN_ROLE';
}

export const actorWithRole = (role: TestActor['role'], id = `${role.toLowerCase()}-id`): TestActor => ({
  id,
  role,
});

export const salesActor = (id?: string): TestActor => actorWithRole('VENTAS_ROLE', id);
export const adminActor = (id?: string): TestActor => actorWithRole('ADMIN_ROLE', id);
export const userActor = (id?: string): TestActor => actorWithRole('USER_ROLE', id);
