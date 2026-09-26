import type { Metadata } from "next";

import { Positions } from "@/components/Positions";

export const metadata: Metadata = { title: "My protection" };

export default function Page() {
  return (
    <>
      <h1 className="py-10 text-2xl font-semibold tracking-tight">My protection</h1>
      <Positions />
    </>
  );
}
