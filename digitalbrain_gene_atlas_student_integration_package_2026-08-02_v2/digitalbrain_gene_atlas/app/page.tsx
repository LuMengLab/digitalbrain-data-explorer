import type { Metadata } from "next";
import GeneAtlasExplorer from "./GeneAtlasExplorer";

export const metadata: Metadata = {
  title: "DigitalBrain Gene Atlas",
  description:
    "Explore gene and gene-set abundance across human brain regions and cell classes.",
};

export default function Home() {
  return <GeneAtlasExplorer />;
}
