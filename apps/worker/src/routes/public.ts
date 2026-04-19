export async function handlePublicSummary(): Promise<Response> {
  return Response.json({
    status: 'operational',
    upCount: 0,
    downCount: 0,
    totalCount: 0,
    checkedAt: new Date().toISOString(),
  })
}
