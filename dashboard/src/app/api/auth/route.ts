import { NextResponse } from "next/server";
import { createSessionToken, COOKIE_NAME, COOKIE_MAX_AGE_DAYS } from "@/lib/auth";

export async function POST(request: Request) {
  let body: { code?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }

  const accessCode = process.env.ACCESS_CODE;
  const secret = process.env.COOKIE_SECRET;
  if (!accessCode || !secret) {
    return NextResponse.json({ ok: false, error: "server_misconfigured" }, { status: 500 });
  }

  if (body.code !== accessCode) {
    // Slow path on failure to discourage brute force (basic V1 mitigation)
    await new Promise((r) => setTimeout(r, 800));
    return NextResponse.json({ ok: false, error: "invalid_code" }, { status: 401 });
  }

  const token = await createSessionToken(secret);
  const response = NextResponse.json({ ok: true });
  response.cookies.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE_DAYS * 86400,
  });
  return response;
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(COOKIE_NAME, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return response;
}
