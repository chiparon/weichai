using AssetUpgradeGateway;
using AssetUpgradeGateway.Tests.Fixtures;
using Xunit;

namespace AssetUpgradeGateway.Tests.Scenarios;

public sealed class AttachmentIntakeScenarioTests
{
    [Fact]
    public async Task Clean_pdf_is_saved_and_released()
    {
        var fixture = new ScenarioFixture();
        var result = await fixture.AttachmentService().IntakeAsync(new(ScenarioFixture.TenantId, ScenarioFixture.ActorId, fixture.Pdf(), "corr-1"));
        Assert.True(result.Accepted);
        Assert.Equal(AttachmentState.Released, result.State);
        Assert.Single(fixture.Attachments.Snapshot());
        Assert.Contains(fixture.Audit.Snapshot(), record => record.Action == "attachment.release");
    }

    [Fact]
    public async Task Path_traversal_name_is_quarantined_before_storage()
    {
        var fixture = new ScenarioFixture();
        var result = await fixture.AttachmentService().IntakeAsync(new(ScenarioFixture.TenantId, ScenarioFixture.ActorId, fixture.UnsafeName(), "corr-2"));
        Assert.False(result.Accepted);
        Assert.Equal(AttachmentState.Quarantined, result.State);
        Assert.Empty(fixture.Attachments.Snapshot());
        FixtureAssertions.AssertContainsCode(result.Issues, "attachment.filename.characters");
    }

    [Fact]
    public async Task Cross_tenant_attachment_is_rejected()
    {
        var fixture = new ScenarioFixture();
        var attachment = fixture.Pdf() with { TenantId = ScenarioFixture.OtherTenantId };
        var result = await fixture.AttachmentService().IntakeAsync(new(ScenarioFixture.TenantId, ScenarioFixture.ActorId, attachment, "corr-3"));
        Assert.False(result.Accepted);
        FixtureAssertions.AssertContainsCode(result.Issues, "attachment.mime");
    }

    [Fact]
    public async Task Same_fingerprint_is_idempotent()
    {
        var fixture = new ScenarioFixture();
        var service = fixture.AttachmentService();
        var command = new AttachmentIntakeCommand(ScenarioFixture.TenantId, ScenarioFixture.ActorId, fixture.Pdf(), "corr-4");
        var first = await service.IntakeAsync(command);
        var second = await service.IntakeAsync(command);
        Assert.True(first.Accepted);
        Assert.True(second.Accepted);
        FixtureAssertions.AssertContainsCode(second.Issues, "attachment.duplicate");
    }

    [Fact]
    public void Content_signature_rejects_fake_pdf()
    {
        var policy = new AssetUpgradeGateway.Policies.ContentSignaturePolicy();
        var result = policy.Evaluate("report.pdf", new byte[] { 0x7b, 0x22, 0x78, 0x22 });
        Assert.False(result.Allowed);
        FixtureAssertions.AssertContainsCode(result.Issues, "attachment.signature.mismatch");
    }
}
