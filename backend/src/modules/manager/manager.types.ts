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

export interface CreateSalespersonBody extends AddSalespersonBody {
  groupId: string;
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
