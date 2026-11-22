import type { Database } from "../server/db";
import { runtimeDatabaseRole } from "../server/testDatabase";

const tableGrants = [
  {
    privileges: ["SELECT", "INSERT", "UPDATE", "DELETE"],
    tables: [
      '"session"',
      '"account"',
      '"verification"',
      '"StudySet"',
      '"LibraryFolder"',
      '"StudySetCoOwner"',
      '"StudySetViewer"',
      '"StudySetCopyLink"',
    ],
  },
  {
    privileges: ["SELECT", "INSERT", "UPDATE"],
    tables: [
      '"user"',
      '"rateLimit"',
      '"Attempt"',
      '"CardReview"',
      '"CoOwnerCardReview"',
      '"ViewerCardReview"',
    ],
  },
  {
    privileges: ["SELECT", "INSERT", "DELETE"],
    tables: ['"StudySetInvitation"'],
  },
  { privileges: ["SELECT", "INSERT"], tables: ['"StudySetCopyImport"'] },
  { privileges: ["SELECT"], tables: ['"LibraryMembership"'] },
];
const requiredPrivileges = tableGrants.flatMap(({ privileges, tables }) =>
  tables.flatMap((table) =>
    privileges.map((privilege) => ({ relation: `public.${table}`, privilege })),
  ),
);

export const runtimeGrants = `
  GRANT USAGE ON SCHEMA public TO examprep_runtime;
  ${tableGrants
    .map(
      ({ privileges, tables }) =>
        `GRANT ${privileges.join(", ")} ON ${tables.map((table) => `public.${table}`).join(", ")} TO examprep_runtime;`,
    )
    .join("\n  ")}
  GRANT SELECT ("copyId", "userId", "sourceId", "convertedAt"), INSERT ("copyId", "userId")
    ON public."CloneConversion" TO examprep_runtime;
  GRANT USAGE ON SEQUENCE public.library_manual_rank_seq TO examprep_runtime;
  GRANT EXECUTE ON FUNCTION public.crypt(text, text), public.gen_salt(text, integer),
    public.attempt_graded_responses(jsonb) TO examprep_runtime;
`;

export async function assertRuntimeRole(db: Pick<Database, "$queryRaw">) {
  const [row] = await db.$queryRaw<{ safe: boolean }[]>`
    SELECT (
      current_user = ${runtimeDatabaseRole} AND current_user = session_user
      AND NOT (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls OR r.rolinherit)
      AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member = r.oid)
      AND NOT has_database_privilege(current_database(), 'CREATE')
      AND NOT EXISTS (
        SELECT 1 FROM pg_namespace n WHERE n.nspname !~ '^pg_(temp|toast_temp)_'
          AND has_schema_privilege(n.oid, 'CREATE')
      )
      AND NOT EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND (
          c.relowner = r.oid OR (c.relkind IN ('r', 'p') AND (
            has_table_privilege(c.oid, 'TRUNCATE') OR has_table_privilege(c.oid, 'TRIGGER')
          ))
        )
      )
      AND NOT has_any_column_privilege('public."_prisma_migrations"', 'SELECT, INSERT, UPDATE, REFERENCES')
      AND NOT has_table_privilege('public."_prisma_migrations"', 'DELETE')
      AND NOT has_any_column_privilege('public."LiveSetCutover"', 'SELECT, INSERT, UPDATE, REFERENCES')
      AND NOT has_table_privilege('public."LiveSetCutover"', 'DELETE')
      AND NOT has_column_privilege('public."CloneConversion"', 'recovery', 'SELECT, INSERT, UPDATE')
      AND NOT has_column_privilege('public."CloneConversion"', 'restoredCopyId', 'SELECT, INSERT, UPDATE')
      AND NOT has_any_column_privilege('public."CloneConversion"', 'UPDATE')
      AND NOT has_table_privilege('public."CloneConversion"', 'DELETE')
      AND NOT EXISTS (
        SELECT 1 FROM unnest(ARRAY['copyId', 'userId', 'sourceId', 'convertedAt']) AS c(name)
        WHERE NOT has_column_privilege('public."CloneConversion"', c.name, 'SELECT')
      )
      AND has_column_privilege('public."CloneConversion"', 'copyId', 'INSERT')
      AND has_column_privilege('public."CloneConversion"', 'userId', 'INSERT')
      AND has_schema_privilege('public', 'USAGE')
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_to_recordset(${JSON.stringify(requiredPrivileges)}::jsonb) AS p(relation text, privilege text)
        WHERE NOT has_table_privilege(p.relation, p.privilege)
      )
      AND has_sequence_privilege('public.library_manual_rank_seq', 'USAGE')
      AND NOT has_sequence_privilege('public.library_manual_rank_seq', 'UPDATE')
      AND has_function_privilege('public.crypt(text, text)', 'EXECUTE')
      AND has_function_privilege('public.gen_salt(text, integer)', 'EXECUTE')
      AND has_function_privilege('public.attempt_graded_responses(jsonb)', 'EXECUTE')
    ) AS safe FROM pg_roles r WHERE r.rolname = current_user
  `;
  if (row?.safe !== true)
    throw new Error(
      "The pooled database role failed the restricted runtime privilege check.",
    );
}
