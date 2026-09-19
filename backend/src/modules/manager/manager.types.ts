export interface CreateGroupBody {
  name: string;
  description?: string;
}

export interface AddSalespersonBody {
  name: string;
  email: string;
  password: string;
  phone?: string;
}

export interface AddExistingMemberBody {
  userId: string;
}

export interface UpdateGroupBody {
  name?: string;
  description?: string;
  status?: "ACTIVE" | "INACTIVE";
}

export interface UpdateSalespersonBody {
  name?: string;
  phone?: string;
  status?: "ACTIVE" | "INACTIVE";
}
