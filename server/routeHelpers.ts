import { HTTPException } from "hono/http-exception";
import type { Prisma } from "../generated/prisma/client";
import { encodeStorage } from "./storage";

export const json = (value: unknown) =>
  encodeStorage(value) as Prisma.InputJsonValue;
export const unavailable = () =>
  new HTTPException(404, {
    message: "This item is unavailable or belongs to another account.",
  });
export const conflict = () =>
  new HTTPException(409, {
    message:
      "A newer revision was saved on another device. Your changes have been kept here.",
  });
