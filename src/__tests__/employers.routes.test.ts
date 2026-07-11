jest.mock("../db/queries", () => ({
  getEmployerById: jest.fn(),
  getTreasuryBalanceByEmployer: jest.fn(),
  recordVaultEvent: jest.fn().mockResolvedValue(undefined),
  upsertEmployerVerification: jest.fn(),
  updateTreasuryBalance: jest.fn().mockResolvedValue(undefined),
  findUnclaimedEmployerByEmail: jest.fn().mockResolvedValue(null),
  linkLegacyEmployerToAccount: jest.fn().mockResolvedValue(undefined),
  updateAccountEmail: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../services/kybService", () => ({
  verifyBusinessRegistration: jest.fn(),
}));

// Real auth (rbac.ts) verifies a live Privy JWT — out of scope for these
// route-logic tests, which fake req.user the same way reports/branding/
// payslips route tests already do. quipayId is a distinct sentinel so
// req.user.id (from x-user-id) never accidentally matches it.
jest.mock("../middleware/rbac", () => ({
  authenticateRequest: (req: any, _res: any, next: any) => {
    req.user = {
      id: req.headers["x-user-id"] || "owner-1",
      role: 1,
      accountId: 1,
      quipayId: "QP_TEST_SENTINEL",
    };
    next();
  },
  requireUser: (_req: any, _res: any, next: any) => next(),
}));

import express from "express";
import request from "supertest";
import { employersRouter } from "../routes/employers";
import {
  getEmployerById,
  getTreasuryBalanceByEmployer,
  upsertEmployerVerification,
} from "../db/queries";
import { verifyBusinessRegistration } from "../services/kybService";

const mockGetEmployerById = getEmployerById as jest.Mock;
const mockGetTreasuryBalanceByEmployer =
  getTreasuryBalanceByEmployer as jest.Mock;
const mockUpsertEmployerVerification = upsertEmployerVerification as jest.Mock;
const mockVerifyBusinessRegistration = verifyBusinessRegistration as jest.Mock;

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use("/api/employers", employersRouter);
  return app;
};

describe("employer onboarding and verification routes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("onboards an employer and stores verified status", async () => {
    const app = buildApp();

    mockVerifyBusinessRegistration.mockResolvedValueOnce({
      status: "verified",
      metadata: { provider: "mock" },
    });
    mockUpsertEmployerVerification.mockResolvedValueOnce({
      employer_id: "employer-1",
      verification_status: "verified",
    });

    const res = await request(app)
      .post("/api/employers/onboard")
      .set("x-user-id", "employer-1")
      .set("x-user-role", "user")
      .send({
        businessName: "Acme Payroll Ltd",
        registrationNumber: "RC-12345",
        countryCode: "ng",
        stellarAddress: "G" + "A".repeat(55),
      });

    expect(res.status).toBe(200);
    expect(mockVerifyBusinessRegistration).toHaveBeenCalled();
    expect(res.body.status).toBe("verified");
  });

  it("returns not_started when employer has not onboarded yet", async () => {
    const app = buildApp();
    mockGetEmployerById.mockResolvedValueOnce(null);

    const res = await request(app)
      .get("/api/employers/status")
      .set("x-user-id", "employer-1")
      .set("x-user-role", "user");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("not_started");
  });

  it("blocks treasury deposits for unverified employers", async () => {
    const app = buildApp();
    mockGetEmployerById.mockResolvedValueOnce({
      employer_id: "employer-1",
      verification_status: "pending",
    });

    const res = await request(app)
      .post("/api/employers/treasury/deposit")
      .set("x-user-id", "employer-1")
      .set("x-user-role", "user")
      .send({ amount: "1000", token: "USDC" });

    expect(res.status).toBe(403);
  });

  it("allows treasury deposits for verified employers", async () => {
    const app = buildApp();
    mockGetEmployerById.mockResolvedValueOnce({
      employer_id: "employer-1",
      verification_status: "verified",
    });
    mockGetTreasuryBalanceByEmployer.mockResolvedValueOnce({
      employer: "employer-1",
      balance: "500",
      token: "USDC",
    });

    const res = await request(app)
      .post("/api/employers/treasury/deposit")
      .set("x-user-id", "employer-1")
      .set("x-user-role", "user")
      .send({ amount: "1000", token: "USDC" });

    expect(res.status).toBe(201);
    expect(res.body.amount).toBe("1000");
  });

  it("returns 409 when employer with same Stellar address already exists", async () => {
    const app = buildApp();
    mockVerifyBusinessRegistration.mockResolvedValueOnce({
      status: "verified",
      metadata: {},
    });
    mockUpsertEmployerVerification.mockRejectedValueOnce({
      code: "23505",
      constraint: "employers_pkey",
    });

    const res = await request(app)
      .post("/api/employers/onboard")
      .set("x-user-id", "employer-dup")
      .set("x-user-role", "user")
      .send({
        businessName: "Acme duplicate",
        registrationNumber: "RC-dup",
        countryCode: "ng",
        stellarAddress: "G" + "B".repeat(55),
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Employer with this Stellar address already exists.");
  });

  it("returns 409 when employer with same email already exists", async () => {
    const app = buildApp();
    mockVerifyBusinessRegistration.mockResolvedValueOnce({
      status: "verified",
      metadata: {},
    });
    mockUpsertEmployerVerification.mockRejectedValueOnce({
      code: "23505",
      constraint: "employers_contact_email_key",
    });

    const res = await request(app)
      .post("/api/employers/onboard")
      .set("x-user-id", "employer-dup-2")
      .set("x-user-role", "user")
      .send({
        businessName: "Acme email dup",
        registrationNumber: "RC-dup2",
        countryCode: "ng",
        contactEmail: "dup@example.com",
        stellarAddress: "G" + "C".repeat(55),
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Employer with this email already exists.");
  });

  it("returns 409 when employer with same organization name already exists", async () => {
    const app = buildApp();
    mockVerifyBusinessRegistration.mockResolvedValueOnce({
      status: "verified",
      metadata: {},
    });
    mockUpsertEmployerVerification.mockRejectedValueOnce({
      code: "23505",
      constraint: "employers_business_name_key",
    });

    const res = await request(app)
      .post("/api/employers/onboard")
      .set("x-user-id", "employer-dup-3")
      .set("x-user-role", "user")
      .send({
        businessName: "Acme Name Dup",
        registrationNumber: "RC-dup3",
        countryCode: "ng",
        stellarAddress: "G" + "D".repeat(55),
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Employer with this organization name already exists.");
  });
});
