using AssetUpgradeGateway;
using AssetUpgradeGateway.Domain;
using AssetUpgradeGateway.Policies;
using Xunit;

namespace AssetUpgradeGateway.Tests.Scenarios;

public sealed class PolicyScenarioTests
{
    [Fact]
    public void Quota_policy_counts_new_attachment_and_event()
    {
        var policy = new TenantQuotaPolicy(byteLimit: 10, attachmentLimit: 1, eventLimit: 1);
        var usage = new QuotaSnapshot("tenant", 9, 0, 0, DateTimeOffset.UtcNow);
        var input = new AttachmentInput("a", "tenant", "a.txt", "text/plain", new byte[] { 1, 2 }, true);
        var result = policy.Evaluate(usage, input, true);
        Assert.False(result.Allowed);
        Assert.Contains(result.Issues, issue => issue.Code == "tenant.quota.bytes");
    }

    [Fact]
    public void Event_age_policy_rejects_replay_outside_window()
    {
        var policy = new EventAgePolicy(TimeSpan.FromHours(1));
        var now = DateTimeOffset.UtcNow;
        var old = new AssetEvent("e", "tenant", "asset", "changed", now.AddHours(-2));
        Assert.False(policy.Evaluate(old, now).Allowed);
    }

    [Fact]
    public void Header_policy_rejects_unknown_header()
    {
        var policy = new HeaderPolicy();
        var result = policy.Evaluate(new Dictionary<string, string> { ["actor"] = "a", ["unsafe"] = "x" });
        Assert.False(result.Allowed);
        Assert.Contains(result.Issues, issue => issue.Code == "event.header.invalid");
    }

    [Fact]
    public void Batch_policy_accepts_small_batch()
    {
        var result = new BatchSizePolicy().Evaluate(new[] { 1, 2, 3 }, 3, "batch.limit");
        Assert.True(result.Allowed);
    }
}
