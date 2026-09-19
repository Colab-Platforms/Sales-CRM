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
