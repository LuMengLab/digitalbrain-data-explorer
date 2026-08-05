"""密度标定表的计算：分位数取法、四组齐全、detection 用天然上界。"""
import json

from scripts import compute_density_scale as mod


def _payload(mean_values, detection_values, support_keys):
    return {
        "cell_weighted": {"regions": {"mean": mean_values, "detection": detection_values}},
        "donor_balanced": {"regions": {"mean": mean_values, "detection": detection_values}},
    }


def test_detection_reference_is_the_natural_bound():
    # detection 是比率，语义上界就是 1。用数据派生的 0.9877/0.9458 会让同一个 0.95
    # 在两个规则下渲染出不同密度，这是无意义的差别。
    values = {f"R{i}": (i + 1) / 100 for i in range(60)}
    scales = mod.density_scales([_payload(values, values, values)], set(values))
    for rule in ("cell_weighted", "donor_balanced"):
        assert scales[rule]["detection"]["reference"] == 1


def test_mean_reference_is_the_corpus_p9999_not_the_max():
    # max 会把约四分之一的量程让给极少数离群值。
    values = {f"R{i}": 0.1 for i in range(60)}
    values["R0"] = 99.0
    scales = mod.density_scales([_payload(values, values, values)], set(values))
    assert scales["cell_weighted"]["mean"]["reference"] < 99.0


def test_knots_are_well_formed():
    values = {f"R{i}": (i + 1) / 100 for i in range(60)}
    scales = mod.density_scales([_payload(values, values, values)], set(values))
    for rule in scales:
        for metric in scales[rule]:
            knots = scales[rule][metric]["lowKnots"]
            assert len(knots) == 13, "12 段需要 13 个节点"
            assert knots[0] == 0
            assert knots[-1] == scales[rule][metric]["breakpoint"]
            assert knots == sorted(knots)


def test_only_mapped_regions_count():
    # 没有几何映射的区永远不会被画出来，把它们计入分位数会歪掉标定。
    mapped = {f"R{i}": 0.1 for i in range(60)}
    unmapped = {"GHOST": 99.0}
    scales = mod.density_scales([_payload({**mapped, **unmapped}, mapped, mapped)], set(mapped))
    assert scales["cell_weighted"]["mean"]["reference"] < 99.0


def test_quantiles_land_on_real_values_not_interpolations():
    # 导出的基因值量化到 4 位小数。线性插值会造出数据里不存在、且精度高于数据源的
    # 标定值——实测 p99.99 夹在真实值 3.5091 与 3.5092 之间，线性给出 3.509169，
    # 与设计文档 §十 的实测表差一位。钉住取法，免得日后被"简化"回插值。
    values = {f"R{i}": (i + 1) / 100 for i in range(60)}
    scales = mod.density_scales([_payload(values, values, values)], set(values))
    observed = set(values.values())

    assert scales["cell_weighted"]["mean"]["breakpoint"] == 0.54, \
        "p90 必须取不超过该分位的最大真实值 0.54，而不是插值出来的 0.541"
    for knot in scales["cell_weighted"]["mean"]["lowKnots"]:
        assert knot == 0 or knot in observed, f"节点 {knot} 不是实测取值"
