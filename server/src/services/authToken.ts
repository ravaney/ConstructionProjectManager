import { env } from "../env.js";
import jwt, { type SignOptions } from "jsonwebtoken";

export type AppUser = {
  id: string;
  email: string;
  name: string;
  role: "OWNER" | "CONTRACTOR";
};

export function signToken(user: AppUser): string {
  const options: SignOptions = {
    expiresIn: env.TOKEN_TTL as SignOptions["expiresIn"]
  };

  return jwt.sign(user, env.JWT_SECRET, options);
}

export function verifyToken(token: string): AppUser {
  return jwt.verify(token, env.JWT_SECRET) as AppUser;
}