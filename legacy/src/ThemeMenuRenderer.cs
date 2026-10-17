using System;
using System.Drawing;
using System.Windows.Forms;

namespace Clipchan
{
    /// <summary>
    /// 跟随主题的上下文菜单渲染器。默认 ContextMenuStrip 在暗色面板旁会显得突兀
    /// （白底黑字），这里把底色、文字、悬停高亮、分隔线统一交给设计令牌驱动。
    /// </summary>
    internal sealed class ThemeMenuRenderer : ToolStripProfessionalRenderer
    {
        public ThemeMenuRenderer() : base(new ThemeColorTable()) { }

        protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e)
        {
            e.TextColor = Theme.Ink;   // 令牌驱动，暗色下自动转浅
            base.OnRenderItemText(e);
        }

        protected override void OnRenderArrow(ToolStripArrowRenderEventArgs e)
        {
            e.ArrowColor = Theme.InkSoft;
            base.OnRenderArrow(e);
        }
    }

    /// <summary>把 ProfessionalColorTable 的关键槽位映射到设计令牌。</summary>
    internal sealed class ThemeColorTable : ProfessionalColorTable
    {
        public override Color ToolStripDropDownBackground { get { return Theme.Field; } }
        public override Color MenuBorder { get { return Theme.LineStrong; } }
        public override Color MenuItemBorder { get { return Theme.Accent; } }
        public override Color MenuItemSelected { get { return Theme.SelectFill; } }
        public override Color MenuItemSelectedGradientBegin { get { return Theme.SelectFill; } }
        public override Color MenuItemSelectedGradientEnd { get { return Theme.SelectFill; } }
        public override Color MenuStripGradientBegin { get { return Theme.Field; } }
        public override Color MenuStripGradientEnd { get { return Theme.Field; } }
        public override Color ImageMarginGradientBegin { get { return Theme.Field; } }
        public override Color ImageMarginGradientMiddle { get { return Theme.Field; } }
        public override Color ImageMarginGradientEnd { get { return Theme.Field; } }
        public override Color SeparatorDark { get { return Theme.Line; } }
        public override Color SeparatorLight { get { return Theme.Line; } }
        public override Color ToolStripBorder { get { return Theme.LineStrong; } }
    }
}
