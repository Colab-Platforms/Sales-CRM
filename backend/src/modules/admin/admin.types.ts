export interface CreateManagerBody {
  name: string;
  email: string;
  password: string;
  phone?: string;
}

export interface UpdateManagerBody {
  name?: string;
  phone?: string;
  status?: "ACTIVE" | "INACTIVE";
}

export interface CreateSalespersonBody {
  name: string;
  email: string;
  password: string;
  phone?: string;
  reportingManagerId: string;
}

export interface UpdateSalespersonBody {
  name?: string;
  phone?: string;
  status?: "ACTIVE" | "INACTIVE";
  reportingManagerId?: string;
}
