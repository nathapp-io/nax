import { Box } from "ink";
import type { ReactElement, ReactNode } from "react";

/** One transcript entry, drawn as one of the screen's own fixed rows. */
export function FixedRow({ children }: { readonly children: ReactNode }): ReactElement {
  return (
    <Box height={1} overflow="hidden">
      {children}
    </Box>
  );
}
