import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Nest",
    short_name: "Nest",
    description: "A minimalist todo app powered by Vercel and Supabase.",
    display: "standalone",
    start_url: "/",
    background_color: "#090f1c",
    theme_color: "#090f1c",
    icons: [
      {
        src: "/favicon.ico",
        sizes: "48x48",
        type: "image/x-icon",
      },
    ],
  };
}
