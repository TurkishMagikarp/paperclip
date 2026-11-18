/** Called only after authorization, recovery revalidation, and edge redaction. */
export async function readIssueDetailTail<B, I>(
  boardDisconnected: boolean,
  readBlocker: () => Promise<B>,
  readInterruption: () => Promise<I>,
) {
  if (boardDisconnected) return null;
  const [executionBlocker, interruption] = await Promise.all([readBlocker(), readInterruption()]);
  return { executionBlocker, interruption };
}
