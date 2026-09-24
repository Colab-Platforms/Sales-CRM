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

export interface SalespersonUser {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  role: "SALESPERSON";
  status: string;
  reportingManager: { id: string; name: string; email: string } | null;
}

export interface CreateSalespersonPayload {
  name: string;
  email: string;
  password: string;
  phone?: string;
  reportingManagerId: string;
}

export interface UpdateSalespersonPayload {
  name?: string;
  phone?: string;
  status?: "ACTIVE" | "INACTIVE";
  reportingManagerId?: string;
}
