import { PrismaNeon } from "@prisma/adapter-neon";
import {
  PrismaClient,
  type Prisma,
  type StudySet,
  type Attempt,
} from "../generated/prisma/client";
export function connectDatabase(url: string) {
  return new PrismaClient({
    adapter: new PrismaNeon({ connectionString: url }),
  });
}
/** Runtime-neutral capabilities. Concrete methods avoid incompatible generated generic payload types. */
type Delegate<Model, Where, Create, Update, Order> = {
  findFirst(args: { where: Where }): Promise<Model | null>;
  findFirstOrThrow(args: { where: Where }): Promise<Model>;
  findMany(args: {
    where: Where;
    orderBy?: Order[];
    skip?: number;
    take?: number;
  }): Promise<Model[]>;
  create(args: { data: Create }): Promise<Model>;
  updateMany(args: { where: Where; data: Update }): Promise<{ count: number }>;
  deleteMany(args: { where: Where }): Promise<{ count: number }>;
};
type Tables = {
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
  $queryRaw<T = unknown>(
    query: TemplateStringsArray | Prisma.Sql,
    ...values: unknown[]
  ): Promise<T>;
  studySet: Delegate<
    StudySet,
    Prisma.StudySetWhereInput,
    Prisma.StudySetUncheckedCreateInput,
    Prisma.StudySetUncheckedUpdateManyInput,
    Prisma.StudySetOrderByWithRelationInput
  >;
  attempt: Delegate<
    Attempt,
    Prisma.AttemptWhereInput,
    Prisma.AttemptUncheckedCreateInput,
    Prisma.AttemptUncheckedUpdateManyInput,
    Prisma.AttemptOrderByWithRelationInput
  >;
};
export type Database = Tables & {
  $disconnect(): Promise<void>;
  $transaction<T>(work: (tx: Tables) => Promise<T>): Promise<T>;
};
