import { NextResponse, type NextRequest } from "next/server";
import { COOKIE_NAME, validateSessionToken } from "@/lib/auth";

export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const isPublic =
    path === "/login" || path.startsWith("/api/auth") || path.startsWith("/_next");

  const token = request.cookies.get(COOKIE_NAME)?.value;
  const isAuthed = await validateSessionToken(token, process.env.COOKIE_SECRET ?? "");

  // Not logged in + accessing protected route → /login
  if (!isAuthed && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  // Already logged in + going to /login → /
  if (isAuthed && path === "/login") {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
