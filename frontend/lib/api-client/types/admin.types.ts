export interface ManagerUser {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  role: "MANAGER";
  status: string;
}

export interface CreateManagerPayload {
  name: string;
  email: string;
  password: string;
  phone?: string;
}

export interface UpdateManagerPayload {
  name?: string;
  phone?: string;
  status?: "ACTIVE" | "INACTIVE";
}
