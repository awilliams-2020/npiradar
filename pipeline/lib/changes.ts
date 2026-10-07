// public.provider_changes: the permanent change log. Written by load.ts --diff (NPPES, each monthly
// load), leie.ts (OIG exclusions) and medicare.ts (CMS Medicare files), whenever their source changes. Lives in `public`, outside the
// swapped schemas, so it accumulates. Not reloadable from any download, so it is backed up
// (~/scripts/backup/pg-backup.sh).
export const PROVIDER_CHANGES_DDL = `
CREATE TABLE IF NOT EXISTS public.provider_changes (
  release date NOT NULL,
  npi text NOT NULL,
  change text NOT NULL,      -- NPPES: added | removed | deactivated | reactivated | practice_address
                             --   | practice_phone | primary_taxonomy | name | credential | license
                             -- OIG:   oig_excluded | oig_reinstated
                             -- CMS Medicare: medicare_enrolled | medicare_unenrolled | medicare_opted_out
                             --   | medicare_opt_out_ended | medicare_ordering (old → new program list)
  old_value text,
  new_value text,
  PRIMARY KEY (npi, release, change)
);
CREATE INDEX IF NOT EXISTS idx_provider_changes_release ON public.provider_changes (release, change);
`;
