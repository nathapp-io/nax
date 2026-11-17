import { Box } from "ink";
import type { ReactElement, ReactNode } from "react";
import type { FrameRegion } from "./frame-layout";
import { type StyledLine, StyledLineView } from "./styled-line";
import type { ChatTheme } from "./theme";

/** A stateless frame line disappears entirely when its allocation is zero. */
export function AllocatedLine({
  region,
  line,
  theme,
}: {
  readonly region: FrameRegion;
  readonly line: StyledLine | undefined;
  readonly theme: ChatTheme;
}): ReactElement | null {
  if (region.rows === 0 || line === undefined) return null;
  return (
    <FixedRow>
      <StyledLineView line={line} theme={theme} />
    </FixedRow>
  );
}

/** One transcript entry, drawn as one of the screen's own fixed rows. */
export function FixedRow({ children }: { readonly children: ReactNode }): ReactElement {
  return (
    <Box height={1} overflow="hidden">
      {children}
    </Box>
  );
}
