--- String template rendering with mixcode.render / global render.
local module = "core"
local prompt = render("Review the {module} module under {root}.", {
  module = module,
  root = mixcode.current_workdir(),
})

mixcode.open_tab({
  name = render("review-{module}", { module = module }),
  prompt = prompt,
  thinking = "high",
})

mixcode.open_tab({
  name = "literal-braces",
  prompt = mixcode.render("Use {{name}} to show a literal placeholder; actual name={name}.", {
    name = "world",
  }),
})
