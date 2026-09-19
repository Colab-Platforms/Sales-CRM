export type Role = "ADMIN" | "MANAGER" | "SALESPERSON";

export interface CurrentUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  status: string;
}

export interface LoginPayload {
  email: string;
  password: string;
}

export interface LoginResult {
  user: CurrentUser;
  accessToken: string;
}
