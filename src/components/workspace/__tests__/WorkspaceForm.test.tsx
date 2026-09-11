import { useState } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { open } from "@tauri-apps/plugin-dialog";
import { WorkspaceForm } from "@/components/workspace/WorkspaceForm";
import { makeT, renderWithI18n, useT } from "@/lib/i18n";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/lib/localeSettings", () => ({
  saveLocale: async () => {},
  loadLocale: async () => null,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

const noopSubmit = async () => {};

function LocaleSwitchHarness() {
  const { setLocale } = useT();
  return (
    <div>
      <button data-testid="switch-zh" onClick={() => setLocale("zh")}>
        zh
      </button>
      <WorkspaceForm open={true} onOpenChange={() => {}} onSubmit={noopSubmit} />
    </div>
  );
}

function fillAllFields(t: ReturnType<typeof makeT>) {
  fireEvent.change(screen.getByPlaceholderText(t("workspace.form.namePlaceholder")), {
    target: { value: "n" },
  });
  fireEvent.change(
    screen.getByPlaceholderText(t("workspace.form.rootPathPlaceholder")),
    { target: { value: "p" } },
  );
  fireEvent.change(
    screen.getByPlaceholderText(t("workspace.form.projectDirPlaceholder")),
    { target: { value: "d" } },
  );
  fireEvent.change(
    screen.getByPlaceholderText(t("workspace.form.p4ClientPlaceholder")),
    { target: { value: "c" } },
  );
  fireEvent.change(screen.getByPlaceholderText(t("workspace.form.p4UserPlaceholder")), {
    target: { value: "u" },
  });
}

describe("WorkspaceForm dictionary chrome", () => {
  it("renders labels, placeholders, hint, title, browse, dismiss, and submit from dictionary", () => {
    const t = makeT("en");
    renderWithI18n(
      <WorkspaceForm open={true} onOpenChange={() => {}} onSubmit={noopSubmit} />,
    );
    expect(
      screen.getByRole("heading", { name: t("workspace.form.title") }),
    ).toBeDefined();
    expect(screen.getByText(t("workspace.form.description"))).toBeDefined();
    expect(screen.getByText(t("workspace.form.name"))).toBeDefined();
    expect(
      screen.getByPlaceholderText(t("workspace.form.namePlaceholder")),
    ).toBeDefined();
    expect(screen.getByText(t("workspace.form.rootPath"))).toBeDefined();
    expect(
      screen.getByPlaceholderText(t("workspace.form.rootPathPlaceholder")),
    ).toBeDefined();
    expect(screen.getByText(t("workspace.form.projectDir"))).toBeDefined();
    expect(
      screen.getByPlaceholderText(t("workspace.form.projectDirPlaceholder")),
    ).toBeDefined();
    expect(screen.getByText(t("workspace.form.projectDirHint"))).toBeDefined();
    expect(screen.getByText(t("workspace.form.p4Client"))).toBeDefined();
    expect(
      screen.getByPlaceholderText(t("workspace.form.p4ClientPlaceholder")),
    ).toBeDefined();
    expect(screen.getByText(t("workspace.form.p4User"))).toBeDefined();
    expect(
      screen.getByPlaceholderText(t("workspace.form.p4UserPlaceholder")),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: t("workspace.form.browse") }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: t("workspace.form.dismiss") }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: t("workspace.form.submit") }),
    ).toBeDefined();
  });

  it("shows no error text until submit; empty submit shows all five field errors", () => {
    const t = makeT("en");
    renderWithI18n(
      <WorkspaceForm open={true} onOpenChange={() => {}} onSubmit={noopSubmit} />,
    );
    expect(screen.queryByText(t("workspace.form.error.name"))).toBeNull();
    expect(screen.queryByText(t("workspace.form.error.rootPath"))).toBeNull();
    expect(screen.queryByText(t("workspace.form.error.projectDir"))).toBeNull();
    expect(screen.queryByText(t("workspace.form.error.p4Client"))).toBeNull();
    expect(screen.queryByText(t("workspace.form.error.p4User"))).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: t("workspace.form.submit") }));
    expect(screen.getByText(t("workspace.form.error.name"))).toBeDefined();
    expect(screen.getByText(t("workspace.form.error.rootPath"))).toBeDefined();
    expect(screen.getByText(t("workspace.form.error.projectDir"))).toBeDefined();
    expect(screen.getByText(t("workspace.form.error.p4Client"))).toBeDefined();
    expect(screen.getByText(t("workspace.form.error.p4User"))).toBeDefined();
  });

  it("filling name only then submit shows the other four errors and not the name error", () => {
    const t = makeT("en");
    renderWithI18n(
      <WorkspaceForm open={true} onOpenChange={() => {}} onSubmit={noopSubmit} />,
    );
    fireEvent.change(
      screen.getByPlaceholderText(t("workspace.form.namePlaceholder")),
      { target: { value: "My WS" } },
    );
    fireEvent.click(screen.getByRole("button", { name: t("workspace.form.submit") }));
    expect(screen.queryByText(t("workspace.form.error.name"))).toBeNull();
    expect(screen.getByText(t("workspace.form.error.rootPath"))).toBeDefined();
    expect(screen.getByText(t("workspace.form.error.projectDir"))).toBeDefined();
    expect(screen.getByText(t("workspace.form.error.p4Client"))).toBeDefined();
    expect(screen.getByText(t("workspace.form.error.p4User"))).toBeDefined();
  });

  it("onSubmit reject with Error(boom) paints boom as raw sibling text", async () => {
    const t = makeT("en");
    const onSubmit = vi.fn().mockRejectedValue(new Error("boom"));
    renderWithI18n(
      <WorkspaceForm open={true} onOpenChange={() => {}} onSubmit={onSubmit} />,
    );
    fillAllFields(t);
    fireEvent.click(screen.getByRole("button", { name: t("workspace.form.submit") }));
    await waitFor(() => {
      expect(screen.getByText("Error: boom")).toBeDefined();
    });
  });

  it("re-translates field errors on locale switch without resubmitting", () => {
    const t = makeT("en");
    renderWithI18n(<LocaleSwitchHarness />);
    fireEvent.click(screen.getByRole("button", { name: t("workspace.form.submit") }));
    expect(screen.getByText(t("workspace.form.error.name"))).toBeDefined();
    fireEvent.click(screen.getByTestId("switch-zh"));
    const tZh = makeT("zh");
    expect(screen.getByText(tZh("workspace.form.error.name"))).toBeDefined();
    expect(screen.queryByText(t("workspace.form.error.name"))).toBeNull();
  });

  it("zh smoke: submit button name equals workspace.form.submit", () => {
    const tZh = makeT("zh");
    renderWithI18n(
      <WorkspaceForm open={true} onOpenChange={() => {}} onSubmit={noopSubmit} />,
      { locale: "zh" },
    );
    expect(
      screen.getByRole("button", { name: tZh("workspace.form.submit") }),
    ).toBeDefined();
  });

  it("dismiss button name equals workspace.form.dismiss — never a single-word English dismiss", () => {
    const t = makeT("en");
    renderWithI18n(
      <WorkspaceForm open={true} onOpenChange={() => {}} onSubmit={noopSubmit} />,
    );
    expect(
      screen.getByRole("button", { name: t("workspace.form.dismiss") }),
    ).toBeDefined();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("successful onSubmit still clears fields", async () => {
    const t = makeT("en");
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderWithI18n(
      <WorkspaceForm open={true} onOpenChange={() => {}} onSubmit={onSubmit} />,
    );
    fillAllFields(t);
    fireEvent.click(screen.getByRole("button", { name: t("workspace.form.submit") }));
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
    expect(
      (screen.getByPlaceholderText(t("workspace.form.namePlaceholder")) as HTMLInputElement)
        .value,
    ).toBe("");
    expect(
      (
        screen.getByPlaceholderText(
          t("workspace.form.rootPathPlaceholder"),
        ) as HTMLInputElement
      ).value,
    ).toBe("");
    expect(
      (
        screen.getByPlaceholderText(
          t("workspace.form.projectDirPlaceholder"),
        ) as HTMLInputElement
      ).value,
    ).toBe("");
    expect(
      (
        screen.getByPlaceholderText(
          t("workspace.form.p4ClientPlaceholder"),
        ) as HTMLInputElement
      ).value,
    ).toBe("");
    expect(
      (
        screen.getByPlaceholderText(
          t("workspace.form.p4UserPlaceholder"),
        ) as HTMLInputElement
      ).value,
    ).toBe("");
  });
});

describe("WorkspaceForm — canonical Add-Workspace chrome", () => {
  function renderOpen() {
    return renderWithI18n(
      <WorkspaceForm open={true} onOpenChange={() => {}} onSubmit={noopSubmit} />,
    );
  }

  it("DialogTitle uses text-section font-medium", () => {
    const t = makeT("en");
    renderOpen();
    const title = screen.getByRole("heading", { name: t("workspace.form.title") });
    expect(title.className).toContain("text-section");
    expect(title.className).toContain("font-medium");
  });

  it("Browse is a labelled outline sibling of rootPath in a nowrap flex row", () => {
    const t = makeT("en");
    renderOpen();
    const browse = screen.getByRole("button", { name: t("workspace.form.browse") });
    expect(browse).toHaveAttribute("data-variant", "outline");
    const root = screen.getByLabelText(t("workspace.form.rootPath"));
    const row = root.parentElement;
    expect(row).not.toBeNull();
    expect(row!.className).toContain("flex-nowrap");
    expect(root.className).toContain("flex-1");
    expect(root.className).toContain("min-w-0");
    expect(browse.className).toContain("shrink-0");
    expect(row!.contains(browse)).toBe(true);
  });

  it("P4 Client and P4 User stay separate in a 2-col grid that collapses at narrow", () => {
    const t = makeT("en");
    renderOpen();
    const client = screen.getByLabelText(t("workspace.form.p4Client"));
    const user = screen.getByLabelText(t("workspace.form.p4User"));
    expect(client).not.toBe(user);
    const grid = client.closest(".grid");
    expect(grid).not.toBeNull();
    expect(grid!.className).toContain("grid-cols-2");
    expect(grid!.className).toContain("narrow:grid-cols-1");
    expect(grid!.contains(user)).toBe(true);
  });

  it("long root and project values wrap with mono overflow-wrap anywhere", () => {
    const t = makeT("en");
    renderOpen();
    const root = screen.getByLabelText(t("workspace.form.rootPath"));
    const project = screen.getByLabelText(t("workspace.form.projectDir"));
    expect(root.className).toContain("font-mono");
    expect(root.className).toContain("[overflow-wrap:anywhere]");
    expect(project.className).toContain("font-mono");
    expect(project.className).toContain("[overflow-wrap:anywhere]");
  });

  it("sticky DialogFooter keeps labelled dismiss and submit visible", () => {
    const t = makeT("en");
    renderOpen();
    const submit = screen.getByRole("button", { name: t("workspace.form.submit") });
    const dismiss = screen.getByRole("button", { name: t("workspace.form.dismiss") });
    const footer = submit.closest("[data-slot='dialog-footer']");
    expect(footer).not.toBeNull();
    expect(footer!.className).toContain("sticky");
    expect(footer!.className).toContain("border-t");
    expect(footer!.className).toContain("bg-popover");
    expect(footer!.className).toContain("pt-4");
    expect(footer!.contains(dismiss)).toBe(true);
    expect(dismiss).toHaveAttribute("data-variant", "ghost");
    expect(submit).toHaveAttribute("data-variant", "default");
  });

  it("Browse, submit, and dismiss meet coarse-pointer 44px hit targets", () => {
    const t = makeT("en");
    renderOpen();
    for (const name of [
      t("workspace.form.browse"),
      t("workspace.form.submit"),
      t("workspace.form.dismiss"),
    ]) {
      const btn = screen.getByRole("button", { name });
      expect(btn.className).toContain("min-h-11");
    }
  });
});

function DismissWithoutUnmountHarness() {
  const [open, setOpen] = useState(true);
  return (
    <div>
      <button type="button" data-testid="reopen" onClick={() => setOpen(true)}>
        reopen
      </button>
      <WorkspaceForm open={open} onOpenChange={setOpen} onSubmit={noopSubmit} />
    </div>
  );
}

describe("WorkspaceForm — browse call-shape and empty-on-open", () => {
  beforeEach(() => {
    vi.mocked(open).mockReset();
  });

  it("Browse calls open({ directory: true, multiple: false }) and writes the path", async () => {
    const t = makeT("en");
    vi.mocked(open).mockResolvedValue("E:\\UnrealProject");
    renderWithI18n(
      <WorkspaceForm open={true} onOpenChange={() => {}} onSubmit={noopSubmit} />,
    );
    fireEvent.click(screen.getByRole("button", { name: t("workspace.form.browse") }));
    await waitFor(() => {
      expect(open).toHaveBeenCalledWith({ directory: true, multiple: false });
    });
    expect(screen.getByDisplayValue("E:\\UnrealProject")).toBeDefined();
  });

  it("fresh open has no aria-invalid fields and no per-field error text", () => {
    const t = makeT("en");
    renderWithI18n(
      <WorkspaceForm open={true} onOpenChange={() => {}} onSubmit={noopSubmit} />,
    );
    expect(screen.queryByText(t("workspace.form.error.name"))).toBeNull();
    expect(screen.queryByText(t("workspace.form.error.rootPath"))).toBeNull();
    expect(screen.queryByText(t("workspace.form.error.projectDir"))).toBeNull();
    expect(screen.queryByText(t("workspace.form.error.p4Client"))).toBeNull();
    expect(screen.queryByText(t("workspace.form.error.p4User"))).toBeNull();
    expect(document.querySelector('[aria-invalid="true"]')).toBeNull();
  });

  it("dismiss via onOpenChange(false) does not clear a typed name while mounted", async () => {
    const t = makeT("en");
    renderWithI18n(<DismissWithoutUnmountHarness />);
    fireEvent.change(
      screen.getByPlaceholderText(t("workspace.form.namePlaceholder")),
      { target: { value: "Draft WS" } },
    );
    fireEvent.click(screen.getByRole("button", { name: t("workspace.form.dismiss") }));
    fireEvent.click(screen.getByTestId("reopen"));
    await waitFor(() => {
      expect(
        (
          screen.getByPlaceholderText(
            t("workspace.form.namePlaceholder"),
          ) as HTMLInputElement
        ).value,
      ).toBe("Draft WS");
    });
  });
});
