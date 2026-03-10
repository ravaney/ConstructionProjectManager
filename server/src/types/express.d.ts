import type { AppUser } from "../services/authToken.js";

declare global {
  namespace Express {
    interface Request {
      user?: AppUser;
    }
  }
}

export {};