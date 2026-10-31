export interface PackageImage {
  id: string;
  alt: string;
  caption: string;
  width: number;
  height: number;
}

export interface PackageDetails {
  audience: string;
  deliverables: string;
  shootScope: string;
  pricingConditions: string;
  benefits: string[];
  exclusions: string[];
  itinerary: Array<{ time: string; title: string; description: string }>;
  process: Array<{ title: string; description: string }>;
  extraCosts: Array<{ name: string; priceLabel: string; condition: string }>;
  preparationNotes: string;
  depositPolicy: string;
  cancellationPolicy: string;
  priceNotes: string;
  gallery: PackageImage[];
}

export type PackageImageInput = Pick<PackageImage, 'alt' | 'caption'> & {
  id?: string;
  uploadIndex?: number;
};

export type PackageDetailsInput = Omit<PackageDetails, 'gallery'> & {
  gallery: PackageImageInput[];
};
