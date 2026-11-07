import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

vi.mock("../aiApi.js", async (importActual) => {
  const actual = await importActual();
  return {
    ...actual,
    ai: {
      predictiveStats: vi.fn(),
      predictiveModelPerformance: vi.fn(),
      predictions: vi.fn(),
      predictionExplanation: vi.fn(),
      runPrediction: vi.fn(),
      markPredictionsStale: vi.fn(),
      recommendations: vi.fn(),
      recommendation: vi.fn(),
      recommendationFeedback: vi.fn(),
      addRecommendationFeedback: vi.fn(),
      generateRecommendations: vi.fn(),
      predictiveModels: vi.fn(),
      predictiveModelVersions: vi.fn(),
      predictiveFeatures: vi.fn(),
      predictiveFeatureValues: vi.fn(),
      predictiveFeatureStatus: vi.fn(),
      predictiveDatasets: vi.fn(),
      predictiveDatasetVersions: vi.fn(),
      predictionAnalytics: vi.fn(),
      predictiveSchedules: vi.fn(),
      upsertPredictiveSchedule: vi.fn(),
      updatePredictiveSchedule: vi.fn(),
    },
  };
});

import { ai } from "../aiApi.js";
import AiPredictiveIntelligencePage from "./AiPredictiveIntelligencePage.jsx";

function renderPage() {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AiPredictiveIntelligencePage />
    </MemoryRouter>,
  );
}

const PREDICTION = {
  id: 12,
  prediction_key: "pred-1",
  prediction_type: "defect_risk",
  subject_type: "product_item",
  subject_id: 100,
  risk_category: "high",
  score: 72.5,
  severity: "high",
  method: "statistical",
  model_version: "1.0.0",
  ruleset_version: "r1",
  confidence: 0.6,
  uncertainty: { kind: "STATISTICAL_ESTIMATE", note: "wide interval" },
  contributing_factors: [],
  evidence: [],
  explanation: "Elevated defect history.",
  limitations: ["limited history"],
  status: "active",
  stale: false,
  generated_at: "2026-01-01T00:00:00Z",
};

const RECOMMENDATION = {
  id: 21,
  recommendation_key: "rec-1",
  title: "Reinspect supplier lot",
  prediction_id: 12,
  severity: "high",
  priority: "high",
  status: "under_review",
  owner_role: "quality_engineer",
  rationale: "Repeated defects",
  suggested_action: "Tighten incoming inspection",
  risk_before: 72.5,
  risk_after: null,
  risk_reduced: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  ai.predictiveStats.mockResolvedValue({
    feature_definitions: 3,
    feature_values: 40,
    stale_feature_values: 2,
    datasets: 1,
    models: 2,
    predictions: 5,
    active_predictions: 4,
    insufficient_data_predictions: 1,
    recommendations: 3,
    open_recommendations: 2,
    accepted_recommendations: 1,
    reduced_risk_recommendations: 1,
    schedules: 1,
    status: "ok",
  });
  ai.predictiveModelPerformance.mockResolvedValue({
    prediction_count: 5,
    active_count: 4,
    stale_count: 0,
    insufficient_data_count: 1,
    risk_distribution: { high: 3, low: 2 },
    monitored_metrics: false,
    note: "rule-based strategies only",
  });
  ai.predictions.mockResolvedValue({
    items: [PREDICTION],
    total: 1,
    limit: 50,
    offset: 0,
  });
  ai.predictionExplanation.mockResolvedValue({
    prediction: PREDICTION,
    summary: "Elevated defect history.",
    contributing_factors: [
      { factor: "defect_rate", value: 0.2, contribution: 0.5, detail: {} },
    ],
    evidence: [],
    limitations: ["limited history"],
    data_freshness: {},
    method_label: "Statistical estimate",
  });
  ai.runPrediction.mockResolvedValue(PREDICTION);
  ai.markPredictionsStale.mockResolvedValue({ marked: 2 });
  ai.recommendations.mockResolvedValue({
    items: [RECOMMENDATION],
    total: 1,
    limit: 50,
    offset: 0,
  });
  ai.recommendation.mockResolvedValue({
    ...RECOMMENDATION,
    status: "accepted",
    reviewed_by: "alice",
  });
  ai.recommendationFeedback.mockResolvedValue([
    {
      id: 1,
      recommendation_id: 21,
      reviewer: "alice",
      decision: "accept",
      comment: "agreed",
      created_at: "2026-01-02T00:00:00Z",
    },
  ]);
  ai.addRecommendationFeedback.mockResolvedValue({
    id: 2,
    recommendation_id: 21,
    decision: "accept",
    comment: "looks good",
  });
  ai.generateRecommendations.mockResolvedValue([RECOMMENDATION]);
  ai.predictiveModels.mockResolvedValue({
    items: [
      {
        id: 5,
        model_key: "defect-v1",
        prediction_type: "defect_risk",
        method: "statistical",
        lifecycle_status: "active",
        version: 1,
      },
    ],
    total: 1,
    limit: 50,
    offset: 0,
  });
  ai.predictiveModelVersions.mockResolvedValue([
    {
      id: 6,
      model_id: 5,
      version: "1.0.0",
      method: "statistical",
      ruleset_version: "r1",
      lifecycle_status: "active",
    },
  ]);
  ai.predictiveFeatures.mockResolvedValue({
    items: [
      {
        id: 7,
        feature_key: "defect_rate",
        entity_type: "product_item",
        data_type: "number",
        freshness_ttl_hours: 168,
        lifecycle_status: "active",
      },
    ],
    total: 1,
    limit: 50,
    offset: 0,
  });
  ai.predictiveFeatureValues.mockResolvedValue({
    items: [
      {
        id: 8,
        feature_key: "defect_rate",
        entity_type: "product_item",
        entity_id: 100,
        value: 0.2,
        stale: false,
        observed_at: "2026-01-01T00:00:00Z",
      },
    ],
    total: 1,
    limit: 50,
    offset: 0,
  });
  ai.predictiveFeatureStatus.mockResolvedValue({
    feature_key: "defect_rate",
    defined: true,
    value_count: 40,
    stale_count: 2,
    latest_observed_at: "2026-01-01T00:00:00Z",
    freshness_ttl_hours: 168,
    status: "ok",
  });
  ai.predictiveDatasets.mockResolvedValue({
    items: [
      {
        id: 9,
        dataset_key: "defects-2025",
        prediction_type: "defect_risk",
        lifecycle_status: "ready",
        feature_keys: ["defect_rate"],
        version: 2,
      },
    ],
    total: 1,
    limit: 50,
    offset: 0,
  });
  ai.predictiveDatasetVersions.mockResolvedValue([
    {
      id: 10,
      dataset_id: 9,
      version: 1,
      split: "train",
      row_count: 500,
      lifecycle_status: "ready",
    },
  ]);
  ai.predictionAnalytics.mockResolvedValue({
    kind: "risk_by_type",
    rows: [
      { key: "defect_risk", label: "defect_risk", count: 5, risk_category: "high" },
    ],
    total: 1,
    truncated: false,
    summary: { predictions: 5 },
  });
  ai.predictiveSchedules.mockResolvedValue({
    items: [
      {
        id: 11,
        schedule_key: "daily-defect",
        prediction_type: "defect_risk",
        subject_type: "product_item",
        interval_seconds: 86400,
        enabled: true,
        next_run_at: "2026-01-02T00:00:00Z",
        last_run_at: null,
      },
    ],
    total: 1,
    limit: 50,
    offset: 0,
  });
  ai.upsertPredictiveSchedule.mockResolvedValue({ id: 12 });
  ai.updatePredictiveSchedule.mockResolvedValue({ id: 11, enabled: false });
});

describe("AiPredictiveIntelligencePage", () => {
  it("renders overview summary and model performance", async () => {
    renderPage();
    expect(
      screen.getByRole("heading", {
        name: "Predictive intelligence & recommendations",
      }),
    ).toBeInTheDocument();
    expect(await screen.findByText(/Active predictions: 4/)).toBeInTheDocument();
    expect(screen.getByText(/Monitored metrics:/)).toBeInTheDocument();
    expect(ai.predictiveStats).toHaveBeenCalled();
    expect(ai.predictiveModelPerformance).toHaveBeenCalled();
  });

  it("lists and explains a prediction", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "Predictions" }));
    await user.click(await screen.findByRole("button", { name: "pred-1" }));
    expect(await screen.findByText(/Method: Statistical/)).toBeInTheDocument();
    expect(screen.getByText(/limited history/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Explain" }));
    expect(await screen.findByText("defect_rate")).toBeInTheDocument();
    expect(ai.predictionExplanation).toHaveBeenCalledWith(12);
  });

  it("runs a prediction with numeric subject id", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "Predictions" }));
    const [runSubjectId] = screen.getAllByPlaceholderText("Subject id");
    await user.type(runSubjectId, "100");
    await user.click(screen.getByRole("button", { name: "Predict" }));
    expect(ai.runPrediction).toHaveBeenCalledWith({
      prediction_type: "defect_risk",
      subject_type: "product_item",
      subject_id: 100,
      observation_window_days: 90,
    });
  });

  it("reviews a recommendation and records feedback", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "Recommendations" }));
    await user.click(await screen.findByRole("button", { name: "Reinspect supplier lot" }));
    expect(await screen.findByText(/Owner role: quality_engineer/)).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText("Review note"), "looks good");
    await user.click(screen.getByRole("button", { name: "Accept" }));
    expect(ai.addRecommendationFeedback).toHaveBeenCalledWith(21, {
      decision: "accept",
      comment: "looks good",
    });
    expect(await screen.findByText("agreed")).toBeInTheDocument();
  });

  it("loads models and model versions", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "Models" }));
    expect(await screen.findByText("defect-v1")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "defect-v1" }));
    expect(await screen.findByText("1.0.0")).toBeInTheDocument();
    expect(ai.predictiveModelVersions).toHaveBeenCalledWith(5);
  });

  it("shows feature definitions, values and status", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "Features" }));
    expect((await screen.findAllByText("defect_rate")).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Status" }));
    expect(await screen.findByText(/Values: 40/)).toBeInTheDocument();
    expect(ai.predictiveFeatureStatus).toHaveBeenCalledWith("defect_rate");
  });

  it("loads datasets and dataset versions", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "Datasets" }));
    await user.click(await screen.findByRole("button", { name: "defects-2025" }));
    expect(await screen.findByText("train")).toBeInTheDocument();
    expect(ai.predictiveDatasetVersions).toHaveBeenCalledWith(9);
  });

  it("loads prediction analytics", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "Analytics" }));
    await user.click(screen.getByRole("button", { name: "Load" }));
    expect(await screen.findByText(/Rows:/)).toBeInTheDocument();
    expect(ai.predictionAnalytics).toHaveBeenCalledWith("risk_by_type");
  });

  it("creates and toggles a schedule", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "Schedules" }));
    await user.type(screen.getByPlaceholderText("Schedule key"), "weekly-defect");
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(ai.upsertPredictiveSchedule).toHaveBeenCalledWith({
      schedule_key: "weekly-defect",
      prediction_type: "defect_risk",
      subject_type: "product_item",
      interval_seconds: 86400,
    });
    await user.click(await screen.findByRole("button", { name: "Disable" }));
    expect(ai.updatePredictiveSchedule).toHaveBeenCalledWith(11, { enabled: false });
  });

  it("surfaces API errors", async () => {
    ai.predictions.mockRejectedValueOnce(new Error("boom"));
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "Predictions" }));
    expect(await screen.findByText("boom")).toBeInTheDocument();
  });
});
