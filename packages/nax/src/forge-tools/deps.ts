import {
  hasWriteAccess,
  listHeadChecks,
  listPrComments,
  listReviewThreads,
  readJobLog,
  readPrInfo,
  resolvePrRef,
} from "@/forge";

/** All forge I/O performed by this module goes through this mutable test seam. */
export const _forgeToolsDeps = {
  resolvePrRef,
  readPrInfo,
  listHeadChecks,
  readJobLog,
  listReviewThreads,
  listPrComments,
  hasWriteAccess,
};
