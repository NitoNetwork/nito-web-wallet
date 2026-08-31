export function GET(): Response {
  return new Response('ok\n', {
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8',
    },
    status: 200,
  });
}
