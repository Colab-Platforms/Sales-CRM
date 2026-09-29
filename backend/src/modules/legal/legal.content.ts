// Public legal pages (Meta App publishing requires a Privacy Policy URL and Terms of Service URL).
//
// The wording and the company details below are NOT invented here. Every body is a visible placeholder until the
// approved text is pasted in. To publish: replace `PLACEHOLDER(...)` bodies with the real paragraphs (plain text,
// one array entry per paragraph) and fill LEGAL_DETAILS once - both pages read from it.

export const LEGAL_DETAILS = {
  platformName: "Sales CRM",
  companyLegalName: "[Company Legal Name]",
  supportEmail: "[Support Email]",
  grievanceOfficer: "[Grievance Officer Name and Email]",
  registeredAddress: "[Registered Address]",
  lastUpdated: "[Effective Date]",
} as const;

export interface LegalSection {
  heading: string;
  paragraphs: string[];
  subsections?: LegalSection[];
}

export interface LegalPage {
  path: string;
  title: string;
  description: string;
  sections: LegalSection[];
}

const PLACEHOLDER = (topic: string): string[] => [`[Approved "${topic}" text to be inserted here.]`];

const section = (heading: string, subsections?: LegalSection[]): LegalSection => ({
  heading,
  paragraphs: subsections ? [] : PLACEHOLDER(heading),
  ...(subsections ? { subsections } : {}),
});

export const PRIVACY_POLICY: LegalPage = {
  path: "/privacy-policy",
  title: `Privacy Policy | ${LEGAL_DETAILS.platformName}`,
  description: `How ${LEGAL_DETAILS.platformName} collects, uses, shares and protects personal data, and how to exercise your rights.`,
  sections: [
    section("Data Collection", [section("Personal Identifiers"), section("Contact Details"), section("Professional Data")]),
    section("Use of Data", [section("Service Delivery"), section("Placement Services"), section("Communication")]),
    section("Data Security and Sharing", [section("No Third-Party Sales"), section("Trainer Access")]),
    section("User Rights and Grievance Contact"),
    section("Contact Information"),
  ],
};

export const TERMS_OF_SERVICE: LegalPage = {
  path: "/terms-of-service",
  title: `Terms of Service | ${LEGAL_DETAILS.platformName}`,
  description: `The terms and conditions for using ${LEGAL_DETAILS.platformName}, including enrollment, refunds, liability and grievance redressal.`,
  sections: [
    section("Nature of the Platform", [section("Intermediary Role"), section("No Employer-Employee Relationship")]),
    section("Program Enrollment and Delivery", [section("Hybrid Model"), section("Course Access")]),
    section("Financial Terms and Refund Policy", [section("Pricing"), section("Refunds"), section("Taxes")]),
    section("Limitation of Liability and Disclaimers"),
    section("Intellectual Property", [section("Usage License")]),
    section("Grievance Redressal", [section("Technical Issues"), section("Complaints")]),
    section("Professional Disclaimer"),
  ],
};
